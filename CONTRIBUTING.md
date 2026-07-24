# Contributing

Thank you for contributing to `opencode-openai-images`. The project aims to keep the public contract small, provider-neutral, and safe for local workspaces.

## Setup

Requirements:

- Node.js `>=20`.
- Bun for the repository test command.
- A local checkout; no provider account or real network is needed for normal development.

```bash
npm install
npm run typecheck
npm run build
bun test
```

The package is an OpenCode plugin. Keep the root module’s `default { id, server }` shape intact and do not expose runtime helper exports from the package entrypoint.

## Branches and changes

Use a focused branch for each change. Keep provider-specific experiments in tests, recipes, or explicitly opt-in development material; do not hardcode a provider URL, model, credential, or local path into product code or public examples.

For configuration, transport, file safety, or tool behavior changes:

- update the relevant focused tests;
- preserve fake-relay and no-real-network defaults;
- document compatibility or security boundary changes;
- avoid unrelated formatting or generated-file churn.

## Testing relay compatibility

New relay compatibility should start with an injected fake `fetch` or fake relay. Tests should cover exact API-root joining, authentication/header behavior, JSON or multipart fields, response normalization, provider errors, cancellation, timeout, and capability differences. Do not make the default test suite contact a real relay.

If a real relay test is useful, keep it opt-in, require explicit user configuration, avoid logging secrets, and make it clear that it is not part of the default CI gate.

## Security and privacy

Do not commit API keys, OAuth tokens, private URLs, local filesystem paths, generated images, or provider account data. Report vulnerabilities through the process in [SECURITY.md](SECURITY.md), not in a public issue.

When changing path, URL, header, response, or output code, review the corresponding limits and redaction behavior in [docs/security.md](docs/security.md).

## Commit and pull request expectations

Use clear, focused commit messages. A pull request should explain:

- the problem and intended behavior;
- the files and public contract affected;
- tests and validation run;
- compatibility, billing, security, or documentation impact;
- any external relay or platform limitation that remains.

Keep commits reviewable, do not rewrite shared branch history, and do not include secrets or unrelated generated artifacts. Maintainers may ask for documentation updates when a public option, error, endpoint assumption, or security boundary changes.
