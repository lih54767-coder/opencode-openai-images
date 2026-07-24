# Security model

This document describes the protections implemented by the plugin and the boundaries that remain the responsibility of the host environment.

## Workspace containment

- The session `context.directory` is the workspace root.
- Local input paths are checked for NULs and traversal segments, resolved against the workspace, then checked again after `realpath`.
- External absolute paths, symlink escapes, directories, and non-regular files are rejected.
- `outputDir` and `out` are workspace-relative. Output directory creation rejects symlink components and checks realpath containment.
- Explicit and default output candidate chains are preflighted before the provider request. Existing symlink candidates are rejected rather than skipped.

## Output publication

Output bytes are inspected by magic and dimensions before writing. The actual MIME selects `png`, `jpeg`, or `webp`; a conflicting requested extension is replaced. Publication uses a same-directory temporary file opened with exclusive creation (`wx`), a full-write check, `fsync`, and a non-overwriting hard link. Collisions produce `-v2`, `-v3`, and so on. The writer never intentionally overwrites an existing file.

Hard-link publication depends on filesystem support. Some Windows or network filesystems may reject this strategy; see [Troubleshooting](troubleshooting.md).

## Image and size limits

- Local input, decoded base64/data URLs, downloaded image bytes, and output bytes are limited to 50 MiB (`50 * 1024 * 1024`).
- Remote `Content-Length` is checked before body consumption and streaming byte counts enforce the same limit.
- Successful JSON transport response bodies are limited to 72 MiB encoded bytes. This accommodates one 50 MiB decoded image plus base64 and JSON envelope overhead.
- PNG, JPEG, and WebP are identified by magic and parsed for dimensions. Extensions and declared MIME values are not trusted.
- V1 masks must be PNG, have a directly represented alpha channel, and match the first input dimensions. Palette/transparency-chunk variants may be rejected.

## Remote URL policy and SSRF boundary

Remote result downloads use manual redirects, with at most three redirects. Every initial and redirected URL is revalidated. URLs must:

- use HTTPS;
- contain no username or password;
- not target `localhost` or a localhost subdomain;
- not use a literal private or reserved IPv4/IPv6 address.

The literal-host policy does **not** resolve DNS and does not prevent DNS rebinding. It is not a complete SSRF sandbox. Deployments that handle untrusted provider-controlled URLs should add DNS-aware egress controls, an allowlist, outbound proxy policy, network isolation, or equivalent controls.

## Secrets and headers

Use host interpolation such as `{env:NAME}` or `{file:PATH}` for secrets. Do not commit keys, expose them in tool descriptions, or paste them into issue reports. Transport errors redact configured base URLs, API keys, and custom header values before clipping messages. Tool metadata retains only bounded, operational fields such as error code, HTTP status, provider code/type, and request ID where available.

Configure either `apiKey` or `headers.Authorization`, not both. Header names must be HTTP tokens; control characters and transport-controlled/hop-by-hop headers are rejected. A custom header should be used only when the relay requires it and should not contain credentials in a description or model-visible field.

## Billing and retries

The plugin performs no automatic retry for image POST requests. A timeout, caller abort, or provider error may happen after the upstream has accepted a request; callers should treat uncertain failures as potentially billed and confirm relay behavior before manually retrying.

## Host responsibilities

The plugin does not replace operating-system permissions, process isolation, network egress policy, DNS security, secret storage, or provider account controls. Run it with the least filesystem and network access needed by the configured workflow.
