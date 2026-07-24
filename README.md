# opencode-openai-images

[![CI](https://github.com/lih54767-coder/opencode-openai-images/actions/workflows/ci.yml/badge.svg)](https://github.com/lih54767-coder/opencode-openai-images/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

An OpenCode plugin that exposes configured OpenAI Images-compatible generation and editing connections as local, workspace-safe tools.

> **Status:** `0.1.0` pre-release; the package has not been published to npm; live image-capable relay generation/edit E2E is pending. Fake-relay, file-layer, loader, and package validation evidence has passed. Do not create a release tag or publish to npm until live generation and edit E2E plus public CI evidence are complete.

## V1 scope

V1 provides:

- `openai_image_generate` for text-to-image generation.
- `openai_image_edit` for local input images, reference images, and an optional mask.
- Named connections with configured API roots, models, authentication, headers, capabilities, and defaults.
- OpenAI Images-compatible JSON generation and multipart edit requests.
- `n=1`, non-streaming requests, response normalization, local image inspection, and workspace-safe output files.
- Base64, data URL, and restricted HTTPS URL response assets.
- Atomic non-overwriting output names such as `image.png`, `image-v2.png`, and `image-v3.png`.

V1 does **not** provide a provider registry, automatic model discovery, authentication hooks, MCP, runtime Python, image analysis, image prompt tutorials, automatic retries, or a bundled Skill. Tool descriptions and schemas are the product interface; no Skill is required.

## Request path

```text
OpenCode
  -> plugin tuple options
  -> named connection selection
  -> preflight: arguments, capabilities, output target, local inputs/mask
  -> images/generations (JSON) or images/edits (multipart)
  -> normalized remote asset
  -> magic/MIME/dimension inspection
  -> workspace-local atomic output
  -> tool result and metadata
```

The transport does not read local paths. The tool layer prepares local files before an edit request and materializes remote results after the request.

## Installation

### OpenCode package installation (recommended)

Add the package name and its options directly to `opencode.json` using the tuple form shown below:

1. Save the configuration.
2. Restart OpenCode.
3. OpenCode resolves the npm plugin through its Bun-compatible plugin runtime; users do not need to run `npm install` first.

The package is still a `0.1.0` pre-release and npm publication is pending. This is the intended user flow once the package is available from the configured npm registry.

### Local development

For a local checkout, use the verified compiled-entry flow. Replace the path with an absolute path to the checkout; keep the options object as the second tuple element:

```bash
npm install && npm run build
```

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "/absolute/path/to/opencode-openai-images/dist/index.js",
      {
        "connections": {
          "primary": {
            "baseURL": "https://images.example.com/api/v1",
            "model": "image-model-placeholder",
            "apiKey": "{env:OPENAI_IMAGES_API_KEY}"
          }
        }
      }
    ]
  ]
}
```

Do not use `npm link` for this workflow; the absolute compiled `dist/index.js` tuple is the validated local-development path.

## Minimal `opencode.json`

OpenCode passes the second tuple element as plugin options. The API root is exact: the plugin appends `/images/generations` and `/images/edits`; it does not guess or add `/v1`.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "opencode-openai-images",
      {
        "connections": {
          "primary": {
            "baseURL": "https://images.example.com/api/v1",
            "model": "image-model-placeholder",
            "apiKey": "{env:OPENAI_IMAGES_API_KEY}"
          }
        }
      }
    ]
  ]
}
```

The host OpenCode configuration interpolation supports `{env:NAME}` and `{file:PATH}` strings before the plugin receives its options. For example:

```json
{
  "apiKey": "{file:./secrets/image-relay-token}",
  "headers": {
    "X-Relay-Profile": "{env:IMAGE_RELAY_PROFILE}"
  }
}
```

Keep secrets outside source control. See [configuration](docs/configuration.md) for the complete schema and validation rules.

## Named connections

`connections` is a non-empty map. With one connection, it becomes the default automatically. With multiple connections, `defaultConnection` is required and must name one of them. The tools expose only configured connection names; URLs, API keys, and custom header values are not placed in tool descriptions.

```json
{
  "connections": {
    "primary": {
      "baseURL": "https://images.example.com/api/v1",
      "model": "image-model-placeholder",
      "apiKey": "{env:PRIMARY_IMAGE_KEY}",
      "headers": { "X-Relay-Profile": "primary" },
      "capabilities": { "edit": true, "mask": true }
    },
    "fallback": {
      "baseURL": "https://backup.example.com/images",
      "model": "fallback-image-model",
      "apiKey": "{env:FALLBACK_IMAGE_KEY}",
      "capabilities": { "edit": false, "mask": false }
    }
  },
  "defaultConnection": "primary",
  "outputDir": "outputs"
}
```

## Tool calls

The tool descriptions are intentionally concise and do not teach image prompting. Typical argument shapes are:

```json
{
  "prompt": "test generation",
  "out": "generated/result.png",
  "connection": "primary",
  "outputFormat": "png"
}
```

for `openai_image_generate`, and:

```json
{
  "prompt": "apply the requested edit",
  "images": ["input/subject.png", "input/reference.jpg"],
  "mask": "input/mask.png",
  "out": "edited/result.png",
  "connection": "primary",
  "inputFidelity": "high"
}
```

for `openai_image_edit`. Edit accepts 1–16 input images. A mask applies to the first image and must be a same-size PNG with directly represented alpha. `size` and `quality` are bounded, non-empty relay-facing strings; `background`, `outputFormat`, `moderation`, and `inputFidelity` use the documented enums.

## Outputs and metadata

`outputDir` defaults to `outputs`. An explicit `out` is a workspace-relative path and takes precedence over `outputDir`. Absolute paths, traversal segments, NUL characters, and symlink escapes are rejected. The actual image magic determines the final MIME and extension; a conflicting requested extension is replaced.

Successful tool results include paths in the human-readable output and metadata such as:

```json
{
  "code": "OK",
  "connection": "primary",
  "model": "image-model-placeholder",
  "revisedPrompt": "optional relay response text",
  "outputs": [
    {
      "path": "/workspace/outputs/image.png",
      "mime": "image/png",
      "width": 1024,
      "height": 1024,
      "byteLength": 123456,
      "versioned": false
    }
  ]
}
```

Provider failures expose stable error codes, status/request identifiers where safe, and redacted messages. The plugin does not retry billed POST requests.

## Security boundary

Local inputs and outputs are contained by the session workspace after realpath resolution. Images are inspected by magic bytes rather than filename extension. Local and remote assets are limited to 50 MiB decoded bytes; successful transport response bodies are capped at 72 MiB encoded bytes to leave room for JSON/base64 overhead. Remote asset URLs require HTTPS, have no credentials, reject localhost and private/reserved IP literals, and follow at most three manually revalidated redirects.

This is not a complete SSRF sandbox: DNS resolution, DNS rebinding prevention, and network egress allowlisting belong to the deployment environment. V1 also intentionally requires canonical padded standard base64 and direct-alpha PNG masks. See [security](docs/security.md).

## Compatibility and runtime

### User runtime

- OpenCode `>=1.18.4 <2`.
- OpenCode’s Bun-compatible plugin runtime.
- Node.js and npm are development/release tools, not user prerequisites for running the configured plugin.

The relay must implement the relevant OpenAI Images-compatible endpoints and fields. “OpenAI-compatible” is not a guarantee that every gateway supports image generation or edits.

### Development and release tooling

- Node.js `>=20`.
- npm.
- Bun `>=1.3` for the project test and smoke workflows.
- OpenCode `>=1.18.4 <2` for the loader smoke.

See [protocol compatibility](docs/protocol-compatibility.md) for the exact request and response boundary.

## Development and verification

```bash
npm install
npm run typecheck
npm run build
bun test
npm run verify
npm run smoke:opencode
npm run prepublishOnly
npm pack --dry-run
```

`npm run verify` is the normal validation flow; `npm run smoke:opencode` exercises the compiled plugin through OpenCode; and `npm run prepublishOnly` runs the package release checks without publishing. Tests use fake relays and injected fetch implementations by default. No real network or provider credential is required for the normal test suite. Live image-capable relay generation/edit E2E remains pending, so the current evidence is not a release or npm-publish signal. See [contributing](CONTRIBUTING.md), [troubleshooting](docs/troubleshooting.md), and the [New API / CLIProxyAPI recipe](docs/recipes/new-api-cliproxyapi.md).

## Project documents

- [Configuration](docs/configuration.md)
- [Protocol compatibility](docs/protocol-compatibility.md)
- [Security model](docs/security.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Changelog](CHANGELOG.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
