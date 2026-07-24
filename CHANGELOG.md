# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses semantic versioning once releases are published.

## [Unreleased]

### Added

- OpenCode plugin entrypoint with `openai_image_generate` and `openai_image_edit` tools.
- Named connections with exact API roots, configurable models, authentication, safe custom headers, capabilities, and operation-specific defaults.
- Non-streaming `n=1` generation JSON and multipart edit transport with response normalization.
- Workspace-contained input preparation, PNG/JPEG/WebP inspection, direct-alpha PNG mask validation, 50 MiB local/remote image limits, and 72 MiB successful encoded response-body limit.
- HTTPS-only remote asset materialization with manual redirect limits, literal localhost/private/reserved IP checks, strict padded base64, and caller/timeout cancellation.
- Atomic non-overwriting output publication with MIME-based extensions, versioned collision names, dimensions, byte length, and revised-prompt metadata.
- Fake-relay, transport, file-layer, configuration, tool, and end-to-end integration tests.
- Community configuration, compatibility, security, troubleshooting, contribution, and release-governance documentation.

### Notes

- Version `0.1.0` is currently a pre-release and has not been published to npm.
- Live image-capable relay generation and edit E2E is still pending.
