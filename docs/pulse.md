# Pubky Pulse (optional browser telemetry)

Pulse initializes beside Sentry in `src/instrumentation-client.ts`. It is independent of Sentry;
neither an account nor configuration is required to build or run this app.

Set only `PUBKY_RUNTIME_PULSE_CLIENT_KEY` at runtime to opt in. The key is public and write-only
(`pulse_client_…`), never an admin key. It selects the registered app; no bundle ID is needed.
The SDK uses its hosted endpoint by default. `PUBKY_RUNTIME_PULSE_ENDPOINT` is an optional
override for self-hosting or local testing; unset or blank uses the default. These settings
use the existing synchronous public runtime-config injection; no rebuild is needed.

Omit the client key (or leave it blank) to release without Pulse tracking: the SDK is not
configured, no collectors start, and capture calls are inert. Existing Sentry and Plausible
behavior is unchanged. Malformed provided runtime
settings fail validation, like the other optional configuration tiers.

## Coverage and privacy

- SDK-managed anonymous sessions, page views/duration, uncaught browser errors, unhandled
  promise rejections, and global `fetch` timing/status. No XHR, request/response bodies, replay,
  user identification, session-header propagation, or custom product journeys are enabled.
- `Err.*` factories and non-AppError render-boundary failures share a tiny browser-only bridge.
  Factory errors carry category/code/service/operation/trace metadata, not raw error context.
  Expected failures reuse Sentry's ignore/drop policy. Automatically recaptured AppErrors are
  dropped; React render retries may still create separate errors (see [Sentry](sentry.md)).
- `screenNameForPath` maps dynamic identifiers to route templates and unknown routes to
  `/unknown`; query strings and fragments are excluded. Add new safe route shapes in
  `pulseScreenName` when introducing routes.
- `beforeSend` applies the existing Sentry message/attribute sanitizer, including error stacks,
  without changing the SDK's anonymous identity. Network URLs are reduced to origin; paths,
  credentials, queries and fragments are not retained. Filtering runs before buffering/storage.
- App version is the existing build version. Non-production builds and staging deploys are
  development traffic. This is browser instrumentation only, not the Node SDK or server capture.

## Local verification

Use a local Pulse-compatible collector, for example `http://127.0.0.1:4007/pulse`, and a synthetic
`pulse_client_local_test` key accepted by that fixture. Do not use a real key or hosted
endpoint for automated testing. Open `/sentry-test` on a staging/local deploy and exercise
factory, uncaught, promise and render failures. Navigate between routes and inspect collector
events for templates, redacted errors, and origin-only network metadata. Repeat with the key
removed while retaining the endpoint: the app must still work and the collector must receive
no Pulse requests. A production-mode local server also needs the nine network variables
documented in [environment.md](environment.md).
