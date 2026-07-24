# Configuration

The plugin receives its options from the OpenCode plugin tuple. The top-level value must be an object. Unknown fields are rejected at every documented object level.

## Top-level fields

| Field | Type | Default | Rules |
| --- | --- | --- | --- |
| `connections` | object | — | Required non-empty map of named connections. Names must be non-empty, trimmed, contain no control characters, and be at most 64 characters. |
| `defaultConnection` | string | The only connection, when there is exactly one | Required when there are multiple connections; must name an existing connection. |
| `outputDir` | string | `outputs` | Non-empty workspace-relative path. Rejects NUL, absolute POSIX/Windows paths, drive-letter paths, and any `..` segment. |

`outputDir` is a local output policy. It is not sent to the HTTP Images endpoint.

## Connection fields

Each `connections.<name>` value is an object:

| Field | Type | Default | Rules |
| --- | --- | --- | --- |
| `baseURL` | string | — | Required absolute `http:` or `https:` URL. No whitespace, credentials, query, or fragment. Trailing slashes are removed; no `/v1` or other API prefix is guessed. |
| `model` | string | — | Required non-empty string, at most 256 characters, without control characters. The value is sent as configured. |
| `description` | string | — | Optional, at most 256 characters, without control characters. It is shown in tool connection-selection context. |
| `apiKey` | string | — | Optional non-empty string without control characters. It is sent as `Authorization: Bearer <apiKey>`. |
| `headers` | object | `{}` | Optional string map. Names must be HTTP tokens; values must not contain control characters. |
| `timeoutMs` | integer | `600000` | Positive safe integer no greater than `2147483647`. Applies to transport requests and remote result downloads. |
| `capabilities` | object | `{ "edit": true, "mask": true }` | Optional booleans. `mask` defaults to `edit`; `edit: false, mask: true` is rejected. |
| `defaults` | object | `{ "generate": {}, "edit": {} }` | Separate operation defaults described below. |

`apiKey` must not be combined with a case-insensitive `headers.Authorization` entry. Header names that control the transport are forbidden, including `Host`, `Content-Type`, `Content-Length`, `Connection`, `Keep-Alive`, `Transfer-Encoding`, `Upgrade`, and related proxy/hop-by-hop headers.

## Generate and edit defaults

Both `defaults.generate` and `defaults.edit` accept these common fields:

| Field | Type | Rules |
| --- | --- | --- |
| `size` | string | Non-empty, at most 64 characters, no control characters. Relay/model-specific values are allowed. |
| `quality` | string | Non-empty, at most 64 characters, no control characters. Relay/model-specific values are allowed. |
| `background` | enum | `auto`, `transparent`, or `opaque`. |
| `outputFormat` | enum | `png`, `jpeg`, or `webp`. |
| `outputCompression` | integer | `0`–`100`; requires `outputFormat` to be explicitly `jpeg` or `webp`. |
| `moderation` | enum | `auto` or `low`. |

`defaults.generate` rejects `inputFidelity`. `defaults.edit` additionally accepts:

| Field | Type | Rules |
| --- | --- | --- |
| `inputFidelity` | enum | `low` or `high`. |

The same compression rule is enforced during tool preflight: a request with `outputCompression` must resolve to JPEG or WebP before any provider POST is made.

## Tool arguments

The two registered tools are `openai_image_generate` and `openai_image_edit`.

Generate arguments:

- `prompt`: required non-empty string.
- `out`: optional workspace-relative output path.
- `connection`: optional configured connection name.
- Common image fields: `size`, `quality`, `background`, `outputFormat`, `outputCompression`, and `moderation`.
- Generate does not accept `inputFidelity` or input images.

Edit arguments:

- `prompt`: required non-empty string.
- `images`: required array of 1–16 workspace-relative paths.
- `mask`: optional workspace-relative path applied to the first image.
- `out`, `connection`, and common image fields as above.
- `inputFidelity`: optional `low` or `high`.

The tool schema bounds `size` and `quality` to 64 characters and validates the enums before execution. Input paths and output paths have additional filesystem containment checks; see [Security](security.md).

## Connection selection

If `connection` is omitted, the configured `defaultConnection` is used. If it is supplied, it must be one of the configured names. The tool description lists names, descriptions, and `edit`/`mask` capability flags, but never includes base URLs, API keys, or custom header values.

## Configuration interpolation

OpenCode supports string interpolation in plugin options using forms such as:

```json
{
  "apiKey": "{env:IMAGE_RELAY_API_KEY}",
  "headers": {
    "X-Profile": "{file:./secrets/image-profile}"
  }
}
```

Interpolation is performed by the host configuration layer. Do not commit the referenced secret files or expose their contents in issue reports and tool descriptions.

## Complete example

All hosts and model names below are placeholders:

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
            "apiKey": "{env:PRIMARY_IMAGE_KEY}",
            "headers": {
              "X-Relay-Profile": "{env:PRIMARY_IMAGE_PROFILE}"
            },
            "timeoutMs": 600000,
            "capabilities": { "edit": true, "mask": true },
            "defaults": {
              "generate": {
                "size": "1024x1024",
                "quality": "auto",
                "outputFormat": "png"
              },
              "edit": {
                "inputFidelity": "high",
                "outputFormat": "webp",
                "outputCompression": 80
              }
            }
          },
          "fallback": {
            "baseURL": "https://fallback.example.com/images",
            "model": "fallback-image-model",
            "apiKey": "{file:./secrets/fallback-token}",
            "capabilities": { "edit": false, "mask": false }
          }
        },
        "defaultConnection": "primary",
        "outputDir": "outputs"
      }
    ]
  ]
}
```

The `baseURL` values above are exact API roots. If a relay exposes its Images API below `/api/v1`, include that prefix in `baseURL`; do not rely on the plugin to infer it.
