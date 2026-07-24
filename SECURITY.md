# Security Policy

## Supported versions

The current supported line is the `0.1.x` pre-release line. npm publication has not occurred. Once releases exist, support status will be maintained here and in the release notes.

Older, unmaintained versions may not receive security fixes. Users should upgrade to the latest supported release when one is available.

## Reporting a vulnerability

Use a **private GitHub Security Advisory** rather than a public issue:

<https://github.com/lih54767-coder/opencode-openai-images/security/advisories/new>

If private reporting is not enabled for the repository, contact a project maintainer through an authenticated GitHub channel instead. Do not publish exploit details, credentials, private relay URLs, or personal data in a public issue.

Please include the affected version/commit, a minimal reproduction, impact, and any relevant logs with secrets removed. Do not include API keys, OAuth tokens, subscription credentials, or unredacted request/response bodies.

Maintainers will aim to acknowledge a valid private report within a reasonable time and will coordinate investigation, remediation, and disclosure with the reporter. No fixed response or resolution time is guaranteed while the project remains a pre-release.

## Scope notes

The plugin includes workspace containment, strict image-size and format checks, redacted transport errors, restricted HTTPS asset downloads, and atomic non-overwriting output publication. It is not a complete SSRF sandbox: DNS rebinding prevention, DNS-aware policy, network egress allowlisting, OS permissions, and secret storage remain deployment responsibilities. See [docs/security.md](docs/security.md).
