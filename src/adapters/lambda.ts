import {
  createWorkersFetchHandler,
  createWorkersHandler,
  type AdapterFetchHandler,
  type WorkersFetchHandlerOptions,
  type WorkersHandlerOptions,
} from "./workers.js";

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

export type LambdaHandlerOptions = WorkersHandlerOptions & {
  origin?: string | ((event: LambdaHttpEventV2) => string);
};

export type LambdaFetchHandlerOptions = Omit<WorkersFetchHandlerOptions, "fetch"> & {
  fetch: AdapterFetchHandler;
  origin?: string | ((event: LambdaHttpEventV2) => string);
};

export type LambdaResponseStream = {
  write: (chunk: string | Uint8Array) => boolean | void;
  end: () => void;
  finished?: () => Promise<void>;
};

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

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

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

const originForEvent = (event: LambdaHttpEventV2, options?: Pick<LambdaHandlerOptions, "origin">): string => {
  if (typeof options?.origin === "function") {
    return normalizeOrigin(options.origin(event));
  }
  if (options?.origin) {
    return normalizeOrigin(options.origin);
  }
  const host = event.requestContext?.domainName ?? headerValue(event.headers, "host") ?? "localhost";
  return normalizeOrigin(host);
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
  options?: Pick<LambdaHandlerOptions, "origin">,
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
    return true;
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
  const textBody = isTextResponse(response.headers);
  const cookies = getSetCookies(response.headers);
  return {
    statusCode: response.status,
    headers: responseHeaders(response.headers),
    body: textBody ? textDecoder.decode(buffer) : buffer.toString("base64"),
    isBase64Encoded: !textBody,
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

export const writeWebResponseToLambdaStream = async (
  response: Response,
  responseStream: LambdaResponseStream,
  runtime: Pick<LambdaStreamingRuntime, "HttpResponseStream">,
): Promise<void> => {
  const stream = runtime.HttpResponseStream.from(responseStream, metadataFromWebResponse(response));
  if (response.body) {
    const reader = response.body.getReader();
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      stream.write(result.value);
    }
  } else {
    const body = await response.text();
    if (body) {
      stream.write(textEncoder.encode(body));
    }
  }
  stream.end();
  await stream.finished?.();
};

export const createLambdaHandler =
  (options: LambdaHandlerOptions) =>
  async (event: LambdaHttpEventV2): Promise<LambdaProxyResponseV2> => {
    const request = requestFromLambdaEvent(event, options);
    const response = await createWorkersHandler(options).fetch(request);
    return lambdaResponseFromWebResponse(response);
  };

export const createLambdaFetchHandler =
  (options: LambdaFetchHandlerOptions) =>
  async (event: LambdaHttpEventV2): Promise<LambdaProxyResponseV2> => {
    const request = requestFromLambdaEvent(event, options);
    const response = await createWorkersFetchHandler(options).fetch(request);
    return lambdaResponseFromWebResponse(response);
  };

export const createLambdaStreamingHandler = (
  options: LambdaHandlerOptions,
  runtime?: LambdaStreamingRuntime,
): unknown => {
  const resolvedRuntime = resolveStreamingRuntime(runtime);
  const webHandler = createWorkersHandler(options);
  return resolvedRuntime.streamifyResponse<LambdaHttpEventV2, unknown>(async (event, responseStream) => {
    const request = requestFromLambdaEvent(event, options);
    const response = await webHandler.fetch(request);
    await writeWebResponseToLambdaStream(response, responseStream, resolvedRuntime);
  });
};
