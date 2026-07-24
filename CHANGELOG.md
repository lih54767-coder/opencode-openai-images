# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses semantic versioning once releases are published.

## [Unreleased]

## [0.1.0] - 2026-07-24

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

- This is the `0.1.0` release candidate. The npm package, `v0.1.0` tag, and GitHub Release are still pending.
- The approved real-provider E2E does not guarantee compatibility with every supplier. Real-supplier mask and multi-reference behavior remain unverified; deterministic plugin tests continue to cover the implemented contract and safety boundaries.

### Validation

- Deterministic real OpenCode `1.18.4` runtime smoke passed generation and edit.
- Public CI passed its Linux, macOS, Windows, and pinned OpenCode jobs.
- One approved real external-provider generation and single-image edit E2E passed without retry. Both outputs were valid PNGs and were deleted after validation; no private provider details are recorded here.
