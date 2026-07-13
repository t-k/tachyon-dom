# Server Adapters

Tachyon DOM exposes compatibility exports at `tachyon-dom/adapters` and runtime-specific entries at `tachyon-dom/adapters/workers`, `tachyon-dom/adapters/node`, and `tachyon-dom/adapters/lambda`.

## Shared Contract

Adapters compose static assets with a fetch-style application handler. Buffered routes return complete responses; streaming routes commit status and headers before forwarding chunks. A stream iteration failure terminates the body without injecting error markup, and consumer cancellation closes the source iterator.

Configure public origins, trusted hosts, and proxy behavior explicitly. See [Security](security.md) before deploying an adapter.

## Cloudflare Workers

The Workers entry avoids Node built-ins. It can try a Cloudflare Assets binding before dynamic routes and supports buffered and streaming application responses. Cloudflare Pages packaging is provided by `packageCloudflarePages()` from `tachyon-dom/vite`, which generates a `_worker.js` that tries `env.ASSETS` first.

## Node

The Node adapter supports file-system static assets. Set `staticAssets.fallthroughOnNotFound: true` when missing assets, application paths such as `/healthz`, or non-GET/HEAD requests such as `POST /login` should continue to the application handler.

The adapter derives request URLs from `Host` only when `trustedHosts` is configured, or from a fixed `origin`. Without either, it falls back to `localhost`. Enable `trustProxy` only behind an edge that normalizes forwarded headers.

## AWS Lambda

The Lambda entry supports Function URLs and API Gateway HTTP API v2 events, including response streaming. It derives request URLs from `event.requestContext.domainName` and falls back to `Host` for minimal local events. Configure `origin` when CloudFront or a custom domain changes the public origin.

Buffered Lambda routes return proxy responses. Streaming routes reject before response commitment when configuration or authoritative route metadata fails; failures after commitment terminate the stream.

## Deployment Checklist

- Select the runtime-specific subpath instead of the compatibility barrel when bundle boundaries matter.
- Configure the public origin and trusted proxy/host policy.
- Decide whether missing static assets fall through to routes.
- Treat application stream chunks as trusted HTML.
- Verify cancellation and error behavior in the target runtime.
- Use the same HTML whitespace policy in the app, router, and adapter boundary where applicable.
