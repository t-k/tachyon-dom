# AWS Lambda Adapter Design

## Goal

Add an AWS Lambda adapter for Tachyon DOM server routing so applications can run SSR on Lambda Function URLs or API Gateway HTTP API v2 events. The adapter should reuse the existing Web `Request`/`Response` pipeline, expose a buffered handler for normal Lambda proxy responses, and expose streaming helpers for Lambda response streaming.

## Scope

The adapter supports the Lambda payload format v2.0 shape used by Function URLs and API Gateway HTTP APIs:

- Convert an incoming event into a Web `Request`.
- Convert a Web `Response` into a Lambda proxy response with `statusCode`, `headers`, `body`, `isBase64Encoded`, and `cookies`.
- Create a buffered handler with `createLambdaHandler({ routes })`.
- Create a streaming handler with `createLambdaStreamingHandler({ routes })`.
- Export low-level helpers for tests and advanced runtimes.

REST API v1, ALB events, and Lambda-side static file serving are out of scope. Static assets should be served by S3/CloudFront or another edge/static origin.

## Architecture

`src/adapters/lambda.ts` is a Node/Lambda-specific entry that imports the Workers adapter to reuse `createWorkersHandler()` for route rendering. The Workers adapter remains the canonical Web runtime implementation; Lambda only translates the platform event and response stream boundaries.

The buffered path is:

1. `requestFromLambdaEvent(event, options)` builds a Web `Request`.
2. `createWorkersHandler(options).fetch(request)` renders the route.
3. `lambdaResponseFromWebResponse(response)` returns a Lambda proxy response.

The streaming path is:

1. `createLambdaStreamingHandler(options, runtime?)` resolves `awslambda.streamifyResponse()` and `awslambda.HttpResponseStream.from()`.
2. The wrapped handler builds a Web `Request` and renders a Web `Response`.
3. Response metadata is passed through `HttpResponseStream.from()`.
4. The Web response body is copied chunk-by-chunk to the Lambda response stream.

## Request Conversion

The URL origin is resolved from `options.origin` when provided. Otherwise it defaults to `https://{event.requestContext.domainName}` and falls back to `https://{Host header}` or `https://localhost` for test events. `rawPath` and `rawQueryString` are preserved.

`event.cookies` is joined into the `Cookie` header because Web `Request` exposes cookies through headers. Non-`GET`/`HEAD` bodies are passed through as text or decoded from base64.

## Response Conversion

`Set-Cookie` headers are emitted through the Lambda proxy response `cookies` array. Other headers are emitted through `headers`. Text-like responses are decoded to a string body; binary responses are base64 encoded and set `isBase64Encoded: true`.

For streaming responses, status, headers, and cookies are passed as metadata to `HttpResponseStream.from()`, then chunks are written from the Web response body. This keeps Tachyon DOM streaming compatible with the Lambda Node runtime model.

## Security

The adapter must preserve security headers returned by the router or passed through `securityHeaders`. It must not trust client-provided body encodings beyond the Lambda event fields. The default origin uses the Lambda event domain first to avoid relying on a client-controlled `Host` header when available.

Deployments that rely on absolute redirects or canonical URLs should pass an explicit `origin` option when the Lambda event domain is not the public origin, such as behind CloudFront or a custom domain.

## Testing

Tests cover:

- Buffered SSR handler returns status, headers, security headers, and body.
- Request conversion preserves method, path, query string, cookies, and decoded bodies.
- `Set-Cookie` is mapped to Lambda `cookies`.
- Binary responses are base64 encoded.
- Streaming handler uses `streamifyResponse()` and `HttpResponseStream.from()` metadata and writes chunks without buffering.
- Node-only Lambda adapter is exported separately from Workers.
