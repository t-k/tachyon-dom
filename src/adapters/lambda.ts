import {
  createWorkersFetchHandler,
  createWorkersHandler,
  type AdapterObservabilityHooks,
  type AdapterObservabilityMetadata,
  type AdapterFetchHandler,
  type WorkersFetchHandlerOptions,
  type RouteAdapterHandlerOptions,
} from "./workers.js";
import { Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

export type LambdaHttpEventV2 = {
  version?: string;
  routeKey?: string;
  rawPath?: string;
  rawQueryString?: string;
  cookies?: readonly string[];
  headers?: Record<string, string | undefined>;
  requestContext?: {
    domainName?: string;
    http?: {
      method?: string;
      path?: string;
      protocol?: string;
      sourceIp?: string;
      userAgent?: string;
    };
  };
  body?: string;
  isBase64Encoded?: boolean;
};

export type LambdaProxyResponseV2 = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded: boolean;
  cookies?: string[];
};

export type LambdaHandlerOptions = RouteAdapterHandlerOptions & {
  origin?: string | ((event: LambdaHttpEventV2) => string);
  trustedHosts?: readonly string[];
};

export type LambdaFetchHandlerOptions = Omit<WorkersFetchHandlerOptions, "fetch"> & {
  fetch: AdapterFetchHandler;
  origin?: string | ((event: LambdaHttpEventV2) => string);
  trustedHosts?: readonly string[];
};

export type LambdaResponseStream = Writable;

export type LambdaHttpResponseMetadata = {
  statusCode: number;
  headers: Record<string, string>;
  multiValueHeaders?: Record<string, string[]>;
};

export type LambdaStreamingRuntime = {
  streamifyResponse: <Event = LambdaHttpEventV2, Context = unknown>(
    handler: (event: Event, responseStream: LambdaResponseStream, context: Context) => void | Promise<void>,
  ) => unknown;
  HttpResponseStream: {
    from: (responseStream: LambdaResponseStream, metadata: LambdaHttpResponseMetadata) => LambdaResponseStream;
  };
};

export type LambdaContextMetadata = {
  awsRequestId?: string;
  functionName?: string;
  functionVersion?: string;
  invokedFunctionArn?: string;
  memoryLimitInMB?: string;
  logGroupName?: string;
  logStreamName?: string;
};

const textDecoder = new TextDecoder("utf-8", { fatal: true });

const headerValue = (headers: Record<string, string | undefined> | undefined, name: string): string | undefined => {
  const lowerName = name.toLowerCase();
  const entry = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === lowerName);
  return entry?.[1];
};

const normalizePath = (path: string | undefined): string => {
  if (!path) {
    return "/";
  }
  return path.startsWith("/") ? path : `/${path}`;
};

const normalizeOrigin = (origin: string): string => {
  const candidate = origin.includes("://") ? origin : `https://${origin}`;
  return new URL(candidate).origin;
};

const hostName = (host: string): string => host.toLowerCase().replace(/:\d+$/, "");

const isTrustedHost = (host: string, trustedHosts: readonly string[] | undefined): boolean => {
  if (!trustedHosts || trustedHosts.length === 0) {
    return false;
  }
  const normalized = host.toLowerCase();
  const normalizedName = hostName(normalized);
  return trustedHosts.some((trusted) => {
    const candidate = trusted.toLowerCase();
    return normalized === candidate || normalizedName === candidate;
  });
};

const originForEvent = (
  event: LambdaHttpEventV2,
  options?: Pick<LambdaHandlerOptions, "origin" | "trustedHosts">,
): string => {
  if (typeof options?.origin === "function") {
    return normalizeOrigin(options.origin(event));
  }
  if (options?.origin) {
    return normalizeOrigin(options.origin);
  }
  const domainName = event.requestContext?.domainName;
  if (domainName) {
    return normalizeOrigin(domainName);
  }
  const host = headerValue(event.headers, "host") ?? "localhost";
  const hasTrustedHosts = options?.trustedHosts !== undefined && options.trustedHosts.length > 0;
  if (hasTrustedHosts && !isTrustedHost(host, options.trustedHosts)) {
    throw new Error("Untrusted Host header");
  }
  return normalizeOrigin(isTrustedHost(host, options?.trustedHosts) ? host : "localhost");
};

const methodForEvent = (event: LambdaHttpEventV2): string => event.requestContext?.http?.method ?? "GET";

const headersForEvent = (event: LambdaHttpEventV2): Headers => {
  const headers = new Headers();
  for (const [key, value] of Object.entries(event.headers ?? {})) {
    if (value !== undefined) {
      headers.set(key, value);
    }
  }
  if (event.cookies?.length) {
    headers.set("cookie", event.cookies.join("; "));
  }
  return headers;
};

const bodyForEvent = (event: LambdaHttpEventV2): BodyInit | undefined => {
  const method = methodForEvent(event);
  if (method === "GET" || method === "HEAD" || event.body === undefined) {
    return undefined;
  }
  return event.isBase64Encoded ? Buffer.from(event.body, "base64") : event.body;
};

export const requestFromLambdaEvent = (
  event: LambdaHttpEventV2,
  options?: Pick<LambdaHandlerOptions, "origin" | "trustedHosts">,
): Request => {
  const method = methodForEvent(event);
  const path = normalizePath(event.rawPath ?? event.requestContext?.http?.path);
  const query = event.rawQueryString ? `?${event.rawQueryString}` : "";
  const body = bodyForEvent(event);
  const init = {
    method,
    headers: headersForEvent(event),
    ...(body ? { body, duplex: "half" } : {}),
  } as RequestInit;
  return new Request(`${originForEvent(event, options)}${path}${query}`, init);
};

const getSetCookies = (headers: Headers): string[] => {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  if (getSetCookie) {
    const cookies = getSetCookie.call(headers);
    if (cookies.length > 0) {
      return cookies;
    }
  }
  const cookie = headers.get("set-cookie");
  return cookie ? [cookie] : [];
};

const responseHeaders = (headers: Headers): Record<string, string> => {
  const output: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (key.toLowerCase() !== "set-cookie") {
      output[key] = value;
    }
  });
  return output;
};

const isTextResponse = (headers: Headers): boolean => {
  if (headers.has("content-encoding")) {
    return false;
  }
  const contentType = headers.get("content-type")?.toLowerCase();
  if (!contentType) {
    return false;
  }
  return (
    contentType.startsWith("text/") ||
    contentType.includes("json") ||
    contentType.includes("javascript") ||
    contentType.includes("xml") ||
    contentType === "image/svg+xml"
  );
};

export const lambdaResponseFromWebResponse = async (response: Response): Promise<LambdaProxyResponseV2> => {
  const buffer = Buffer.from(await response.arrayBuffer());
  let decodedBody: string | undefined;
  if (isTextResponse(response.headers)) {
    try {
      const decoded = textDecoder.decode(buffer);
      if (Buffer.from(decoded, "utf8").equals(buffer)) {
        decodedBody = decoded;
      }
    } catch {
      // Invalid UTF-8 must use the byte-preserving base64 representation.
    }
  }
  const cookies = getSetCookies(response.headers);
  return {
    statusCode: response.status,
    headers: responseHeaders(response.headers),
    body: decodedBody ?? buffer.toString("base64"),
    isBase64Encoded: decodedBody === undefined,
    ...(cookies.length > 0 ? { cookies } : {}),
  };
};

const metadataFromWebResponse = (response: Response): LambdaHttpResponseMetadata => {
  const cookies = getSetCookies(response.headers);
  return {
    statusCode: response.status,
    headers: responseHeaders(response.headers),
    ...(cookies.length > 0 ? { multiValueHeaders: { "Set-Cookie": cookies } } : {}),
  };
};

const resolveStreamingRuntime = (runtime?: LambdaStreamingRuntime): LambdaStreamingRuntime => {
  if (runtime) {
    return runtime;
  }
  const candidate = (globalThis as typeof globalThis & { awslambda?: LambdaStreamingRuntime }).awslambda;
  if (!candidate?.streamifyResponse || !candidate.HttpResponseStream?.from) {
    throw new Error(
      "AWS Lambda response streaming requires the Lambda Node.js awslambda runtime or an injected LambdaStreamingRuntime.",
    );
  }
  return candidate;
};

const metadataForContext = (context: unknown): AdapterObservabilityMetadata | undefined => {
  if (!context || typeof context !== "object") {
    return undefined;
  }
  const candidate = context as LambdaContextMetadata;
  const metadata: AdapterObservabilityMetadata = {};
  for (const key of [
    "awsRequestId",
    "functionName",
    "functionVersion",
    "invokedFunctionArn",
    "memoryLimitInMB",
    "logGroupName",
    "logStreamName",
  ] as const) {
    if (candidate[key] !== undefined) {
      metadata[key] = candidate[key];
    }
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
};

const lambdaObservability = (
  observability: AdapterObservabilityHooks | undefined,
  context: unknown,
): AdapterObservabilityHooks | undefined => {
  const metadata = metadataForContext(context);
  if (!observability && !metadata) {
    return undefined;
  }
  return {
    ...observability,
    adapter: "lambda",
    runtime: "aws-lambda",
    ...(metadata || observability?.metadata ? { metadata: { ...observability?.metadata, ...metadata } } : {}),
  };
};

export const writeWebResponseToLambdaStream = async (
  response: Response,
  responseStream: LambdaResponseStream,
  runtime: Pick<LambdaStreamingRuntime, "HttpResponseStream">,
): Promise<void> => {
  const stream = runtime.HttpResponseStream.from(responseStream, metadataFromWebResponse(response));
  const source = response.body ? Readable.fromWeb(response.body as never) : Readable.from([]);
  await pipeline(source, stream);
};

export const createLambdaHandler =
  (options: LambdaHandlerOptions) =>
  async (event: LambdaHttpEventV2, context?: unknown): Promise<LambdaProxyResponseV2> => {
    const request = requestFromLambdaEvent(event, options);
    const response = await createWorkersHandler({
      ...options,
      observability: lambdaObservability(options.observability, context),
    }).fetch(request);
    return lambdaResponseFromWebResponse(response);
  };

export const createLambdaFetchHandler =
  (options: LambdaFetchHandlerOptions) =>
  async (event: LambdaHttpEventV2, context?: unknown): Promise<LambdaProxyResponseV2> => {
    const request = requestFromLambdaEvent(event, options);
    const response = await createWorkersFetchHandler({
      ...options,
      observability: lambdaObservability(options.observability, context),
    }).fetch(request);
    return lambdaResponseFromWebResponse(response);
  };

export const createLambdaStreamingHandler = (
  options: LambdaHandlerOptions,
  runtime?: LambdaStreamingRuntime,
): unknown => {
  const resolvedRuntime = resolveStreamingRuntime(runtime);
  return resolvedRuntime.streamifyResponse<LambdaHttpEventV2, unknown>(async (event, responseStream, context) => {
    const request = requestFromLambdaEvent(event, options);
    const webHandler = createWorkersHandler({
      ...options,
      observability: lambdaObservability(options.observability, context),
    });
    const response = await webHandler.fetch(request);
    await writeWebResponseToLambdaStream(response, responseStream, resolvedRuntime);
  });
};
