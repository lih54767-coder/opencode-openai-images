# Troubleshooting

## Configuration errors

Configuration is strict and rejects unknown fields. Check the reported dotted path, for example `connections.primary.defaults.generate.outputCompression`.

Common causes:

- `connections` is empty or a connection name contains whitespace/control characters.
- Multiple connections are configured without `defaultConnection`.
- `baseURL` has credentials, a query, a fragment, whitespace, or the wrong scheme.
- `outputDir` is absolute or contains a `..` segment.
- `apiKey` is combined with `headers.Authorization`.
- A header name is not an HTTP token, or is a forbidden transport/hop-by-hop header.
- A model or description contains a control character or exceeds its bound.
- `outputCompression` is set without an explicit JPEG/WebP `outputFormat`.
- `defaults.generate.inputFidelity` is present. That field is edit-only.

Use `npm run typecheck` after changing TypeScript, but remember that config validation happens when OpenCode loads the plugin.

## `baseURL`, `/v1`, and `/v1/v1`

The plugin appends `/images/generations` or `/images/edits` to the configured API root. It does not add `/v1` automatically.

If the relay endpoint is:

```text
https://images.example.com/api/v1/images/generations
```

configure:

```json
{ "baseURL": "https://images.example.com/api/v1" }
```

Do not configure `/api/v1/v1`, and do not place `/images/generations` in `baseURL`. Trailing slashes are harmless; query strings and fragments are rejected.

## HTTP errors

Tool results preserve stable transport codes and, when safe, the HTTP status:

- **401:** verify the API key, Bearer authentication, relay account, and selected connection.
- **403:** verify account permissions, model access, relay policy, and whether the connection capability is configured correctly.
- **404:** verify the exact API root and endpoint support. A common cause is an incorrect `/v1` prefix or a relay that does not expose Images routes.
- **429:** check provider quotas/rate limits. The plugin does not automatically retry billed POSTs.
- **5xx:** inspect relay logs and model routing. Confirm the model is available at the selected connection.

Messages redact configured secrets. Save the code/status/request ID instead of copying credentials or full URLs into a report.

## Unsupported fields or model parameters

Unknown configuration fields are rejected intentionally. For provider-specific model parameters, use the supported bounded `size` and `quality` strings only where the relay documents them. `background`, `moderation`, `output_format`, `output_compression`, and `input_fidelity` may be valid locally but unsupported by a particular gateway. Confirm the relay’s Images contract before enabling defaults.

## Base64 and data URLs

V1 requires canonical padded standard base64. Unpadded, URL-safe, whitespace-containing, or otherwise non-canonical values are rejected. A data URL must use the `data:<mime>;base64,<payload>` form. The decoded bytes must still be a valid PNG, JPEG, or WebP; MIME declarations do not override magic inspection.

## Masks

Masks are intentionally strict in V1:

- PNG only.
- Direct alpha in the PNG color type (typically color type 4 or 6).
- Same width and height as the first input image.
- The mask applies to the first image in an edit request.

Palette/transparency-chunk masks may be rejected even if another image viewer displays them with transparency. Convert the mask to a direct-alpha PNG and confirm its dimensions.

## Remote result URLs

Remote materialization accepts HTTPS only. HTTP URLs, credentials, localhost, and literal private/reserved IP addresses are rejected. Redirects are manual, limited to three, and revalidated at every hop. DNS resolution and rebinding protection are outside the plugin; use an egress policy for untrusted environments.

## Timeouts and cancellation

`timeoutMs` defaults to 600000 ms and must be a positive safe integer no greater than 2147483647. The timeout covers the Images request and response-body read. The same timeout signal is passed to remote result downloads; injected/custom fetch implementations must honor `AbortSignal` for cancellation to be effective during their body read. A caller abort returns `ABORTED`; an elapsed transport or remote download timeout returns `TIMEOUT` or `REMOTE_TIMEOUT` metadata. These outcomes do not imply that an upstream request was never accepted.

## Windows and hard-link filesystems

Atomic publication uses a same-directory temporary file and hard link. If the filesystem does not permit hard links, output may fail with `OUTPUT_INVALID`. Use a local filesystem with hard-link support, check directory permissions, and avoid network/special filesystems for the output directory. Do not “fix” this by granting broad write permissions or disabling containment checks.

## Relay model lists

The plugin does not discover or validate a provider’s model list. The configured `model` is sent as-is, subject to local length/control-character validation. Check the relay’s own model list and Images capability documentation, then test the exact endpoint directly before using the OpenCode tool. See the [relay recipe](recipes/new-api-cliproxyapi.md).
