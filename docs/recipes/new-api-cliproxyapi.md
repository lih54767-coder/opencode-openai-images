# New API and CLIProxyAPI recipe

This is an opt-in compatibility recipe, not a provider-specific product branch. Use only generic placeholder domains and your own locally managed credentials.

## New API channel

New API deployments commonly expose a channel-specific API root and allow an administrator to map a custom model name to the upstream Images model. Configure the exact root that serves the Images endpoints and use the channel’s configured model identifier:

```json
{
  "connections": {
    "new-api": {
      "baseURL": "https://new-api.example.com/api/v1",
      "model": "gpt-image-2",
      "apiKey": "{env:NEW_API_IMAGE_KEY}"
    }
  }
}
```

The custom model name may be a deployment alias rather than the upstream name. Confirm the channel mapping and whether the channel permits image generation, edits, masks, and the requested output parameters.

## CLIProxyAPI

CLIProxyAPI `v7.2.77+` can expose Images-compatible generation and edit endpoints when its image feature is enabled. A generic configuration shape is:

```json
{
  "connections": {
    "cliproxyapi": {
      "baseURL": "https://cliproxyapi.example.com/v1",
      "model": "gpt-image-2",
      "apiKey": "{env:CLIPROXYAPI_IMAGE_KEY}"
    }
  }
}
```

### `disable-image-generation` modes

CLIProxyAPI uses this setting to control image capability and tool handling:

| Value | Meaning |
| --- | --- |
| `false` | Image generation is enabled and image-capable requests/tools can be injected. |
| `true` | Image generation is completely disabled. Images requests fail or return `404`; this is not a usable mode for this plugin. |
| `chat` | Ordinary chat/Responses tool injection is disabled, while Images endpoints remain available. |
| `passthrough` | Chat tools are neither injected nor removed, and Images endpoints remain available. |

For a tool-only OpenCode plugin workflow, use `false` when chat-tool injection is acceptable, or `chat` when ordinary chat/Responses tool injection should remain disabled. Use `passthrough` when the surrounding host should retain its existing chat-tool behavior. The exact proxy configuration and authentication setup remain deployment-specific.

## Acceptance order

Validate the path in this order:

1. Call the relay’s Images endpoint directly with the configured API root, model, authentication, and one minimal request.
2. Confirm the response is a supported `b64_json`, data URL, or HTTPS URL and that the returned bytes are a valid image.
3. Confirm edits accept multipart `image[]` parts and the optional `mask` field if needed.
4. Put the same exact API root and model into an `opencode-openai-images` named connection.
5. Invoke the OpenCode tool with an explicit `connection` and workspace-relative `out` path.
6. Compare the tool metadata, output MIME/dimensions, and relay request logs with the direct call.

Do not add `/v1` twice, assume a provider-specific path, or use a URL copied from a dashboard if it contains query parameters or credentials. The plugin requires an exact API root without query or fragment.

## OAuth and subscription bridges

An OAuth or subscription bridge may be a capability of the proxy or relay. Its behavior, account eligibility, quota, and policy are controlled by that proxy. It does not represent an OpenAI service guarantee, an OpenAI SLA, or a promise that every model/account combination supports Images.

Keep proxy credentials in environment variables or host-managed secret files. Do not put tokens, local paths, or private endpoint details in this recipe or in a public issue.
