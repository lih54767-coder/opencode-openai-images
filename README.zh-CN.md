# opencode-openai-images

[English](README.md) | 简体中文

[![CI](https://github.com/lih54767-coder/opencode-openai-images/actions/workflows/ci.yml/badge.svg)](https://github.com/lih54767-coder/opencode-openai-images/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

一个 OpenCode 插件，将已配置的、兼容 OpenAI Images 的生成与编辑连接暴露为本地且限定在工作区内的工具。

> **状态：** `0.1.0` release candidate；npm package、`v0.1.0` tag 和 GitHub Release 仍待完成。fake relay/contract validation、真实 OpenCode `1.18.4` 的确定性生成与编辑 runtime smoke、覆盖 Linux/macOS/Windows 和固定 OpenCode job 的公开 CI，以及一次获批准的真实外部供应商生成和单图编辑 E2E 均已通过。该批准的 E2E 不构成对所有供应商的兼容性保证；真实供应商的 mask 和多参考图行为仍未验证。在单独的 release 审批完成前不要发布。

## V1 范围

V1 提供：

- `openai_image_generate`：文本生成图像。
- `openai_image_edit`：本地输入图像、参考图像和可选 mask 的编辑。
- 命名连接，支持配置 API 根地址、模型、认证、headers、capabilities 和 defaults。
- 兼容 OpenAI Images 的 JSON 生成请求和 multipart 编辑请求。
- `n=1`、非流式请求、响应规范化、本地图像检查，以及工作区安全的输出文件。
- Base64、data URL 和受限 HTTPS URL 响应资源。
- 原子且不覆盖已有文件的输出名称，例如 `image.png`、`image-v2.png` 和 `image-v3.png`。

V1 不提供 provider registry、自动模型发现、认证 hooks、MCP、运行时 Python、图像分析、图像提示词教程、自动重试或内置 Skill。工具描述和 schema 是产品接口；不需要 Skill。

## 请求路径

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

传输层不会读取本地路径。编辑请求前由工具层准备本地文件，请求完成后再将远程结果物化到本地。

## 安装

### OpenCode package 安装（npm 发布后）

对于支持范围内的稳定版 OpenCode（`>=1.18.4 <2`），在 `opencode.json` 中使用如下 plugin tuple 形式直接配置已发布的 package。下面精确的 `opencode-openai-images@0.1.0` specifier 是发布后的确定性示例：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "opencode-openai-images@0.1.0",
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

该 package **尚未发布到 npm**，因此上面的 package-name 示例当前还不能安装。发布后，保存配置并重启 OpenCode；OpenCode 的 Bun-compatible plugin runtime 会解析 npm plugin。不要使用 `opencode plugin` CLI 命令——本项目使用 OpenCode 配置完成安装。

### 本地开发

当前本地开发不需要 npm 发布。构建 checkout，并将已验证的编译入口作为第一个 tuple 元素使用绝对路径；options object 仍作为第二个 tuple 元素：

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

绝对路径的编译产物 `dist/index.js` tuple 是已验证的本地开发路径。上面的 package-name tuple 仅用于 npm 发布后的安装流程。

## 最小 `opencode.json`

OpenCode 将第二个 tuple 元素作为 plugin options 传入。API 根地址必须精确：插件会追加 `/images/generations` 和 `/images/edits`，不会猜测或添加 `/v1`。

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "opencode-openai-images@0.1.0",
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

OpenCode 主机配置支持在 plugin options 中使用 `{env:NAME}` 和 `{file:PATH}` 字符串插值，并在插件接收 options 前完成替换。例如：

```json
{
  "apiKey": "{file:./secrets/image-relay-token}",
  "headers": {
    "X-Relay-Profile": "{env:IMAGE_RELAY_PROFILE}"
  }
}
```

如果 `{env:NAME}` 变量不存在，OpenCode 会将其替换为空字符串；当它被用作 `apiKey` 时，会因本插件要求凭据非空而导致校验失败。缺失的 `{file:PATH}` 引用会使 OpenCode 配置加载失败。不要把密钥放入源代码管理。完整 schema 和校验规则见[配置文档](docs/configuration.md)。

## 命名连接

`connections` 是非空 map。只有一个连接时，它会自动成为默认连接；有多个连接时，必须提供 `defaultConnection`，且其值必须命名其中一个连接。工具只暴露已配置的连接名称；URL、API key 和自定义 header 值不会放入工具描述。

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

## 工具调用

工具描述保持有意简洁，不负责教授图像提示词写法。典型参数形状如下：

```json
{
  "prompt": "test generation",
  "out": "generated/result.png",
  "connection": "primary",
  "outputFormat": "png"
}
```

用于 `openai_image_generate`，以及：

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

用于 `openai_image_edit`。Edit 接受 1–16 张输入图像。mask 应用于第一张图像，并且必须是同尺寸、直接表示 alpha 的 PNG。`size` 和 `quality` 是有边界且非空的、面向 relay 的字符串；`background`、`outputFormat`、`moderation` 和 `inputFidelity` 使用文档规定的枚举。

## 输出和 metadata

`outputDir` 默认为 `outputs`。显式的 `out` 是工作区相对路径，其优先级高于 `outputDir`。绝对路径、遍历片段、NUL 字符和 symlink 逃逸都会被拒绝。实际图像 magic 决定最终 MIME 和扩展名；如果请求扩展名冲突，会被替换。

成功的工具结果会在可读文本中包含路径，并包含如下 metadata：

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

供应商失败会暴露稳定的错误码、在安全情况下提供 status/request 标识符，以及经过脱敏的消息。插件不会重试可能已经计费的 POST 请求。

## 安全边界

在完成 realpath 解析后，本地输入和输出会被限制在会话工作区内。图像通过 magic bytes 而非文件名扩展名检查。本地和远程资源的 decoded bytes 上限为 50 MiB；成功的 transport response body 上限为 72 MiB encoded bytes，为 JSON/base64 开销预留空间。远程资源 URL 必须使用 HTTPS、不能包含凭据、不能指向 localhost 或私有/保留 IP 字面量，并且最多手动重新验证三次重定向。

这不是完整的 SSRF 沙箱：DNS 解析、DNS rebinding 防护和网络出口 allowlist 属于部署环境职责。V1 还明确要求 canonical padded standard base64，以及 direct-alpha PNG mask。详见[安全模型](docs/security.md)。

## 兼容性和运行时

### 用户运行时

- OpenCode `>=1.18.4 <2`。
- OpenCode 的 Bun-compatible plugin runtime。
- Node.js 和 npm 是开发/发布工具，不是运行已配置插件的用户前置条件。

Relay 必须实现相关的、兼容 OpenAI Images 的 endpoints 和字段。“OpenAI-compatible”不保证每个 gateway 都支持图像生成或编辑。

### 开发和发布工具

- Node.js `>=20`。
- npm。
- Bun `>=1.3`，用于项目测试和 smoke 工作流。
- OpenCode `>=1.18.4 <2`，用于 loader smoke。

精确的请求和响应边界见[协议兼容性](docs/protocol-compatibility.md)。

## 开发和验证

```bash
npm install
npm run typecheck
npm run build
bun test
npm run verify
npm run smoke:opencode
npm run smoke:runtime
npm run prepublishOnly
npm pack --dry-run
```

`npm run verify` 是常规验证流程；`npm run smoke:opencode` 通过 OpenCode 验证编译后的插件并检查 registry/interpolation 行为；`npm run smoke:runtime` 运行真实 OpenCode `1.18.4` 的确定性生成与编辑 session smoke；`npm run prepublishOnly` 在不发布的情况下运行 package 发布检查。测试默认使用 fake relay 和注入的 fetch 实现，不需要真实网络或供应商凭据。一次获批准的真实外部供应商生成和单图编辑 E2E 也已在不重试的情况下通过，输出为有效 PNG，并已在验证后删除。该结果不构成对所有供应商的兼容性保证；真实供应商的 mask 和多参考图行为仍未验证。另请参阅[贡献指南](CONTRIBUTING.md)、[故障排查](docs/troubleshooting.md)和 [New API / CLIProxyAPI 配置示例](docs/recipes/new-api-cliproxyapi.md)。

## 项目文档

- [配置](docs/configuration.md)
- [协议兼容性](docs/protocol-compatibility.md)
- [安全模型](docs/security.md)
- [故障排查](docs/troubleshooting.md)
- [发布 SOP](docs/release.md)
- [贡献指南](CONTRIBUTING.md)
- [安全策略](SECURITY.md)
- [变更日志](CHANGELOG.md)
- [行为准则](CODE_OF_CONDUCT.md)
