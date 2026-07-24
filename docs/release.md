# Release SOP

This is a manual, approval-gated procedure for releasing `opencode-openai-images`. It is intentionally not an automation specification: no step in this document authorizes an agent or CI job to create commits, push branches, create tags, create GitHub Releases, or publish to npm without a separate human approval.

The current `0.1.0` package is not published to npm. Fake-relay full-chain evidence and real OpenCode `1.18.4` tool-registry evidence are available. Real external-provider generation/edit E2E, the release tag, GitHub Release, and npm publication remain outstanding gates.

## Non-negotiable rules

- Never reuse an existing `name@version`. A release version must be unused in the target registry and must have a new, exact Git tag.
- Never publish automatically. A successful local check, CI run, GitHub Release, or npm login is not publish approval.
- Never record credentials, tokens, passwords, 2FA OTPs, private endpoint details, or secret-file contents in documents, logs, issue reports, commits, or release summaries.
- Do not treat fake-relay tests or tool-registry registration as proof that a real supplier accepts and bills the request correctly.
- Do not issue a paid generation or edit request without explicit user approval and a confirmed image-capable supplier/model.
- If a gate fails or evidence is ambiguous, stop at that gate. Do not create a tag or publish “to see whether it works.”

## 1. Prepare and inspect

Before running release checks, the release owner should:

1. Confirm the intended branch, commit range, repository, npm registry, package name, and target version.
2. Inspect `git status`, the complete diff, and the files that will enter the package. Keep unrelated changes out of the release candidate.
3. Confirm that the worktree used for evidence is the exact source that will be committed and packaged.
4. Confirm the release candidate does not contain credentials, private relay URLs, generated images, local secret files, or machine-specific paths.

The current package identity is `opencode-openai-images`; the current candidate version is `0.1.0`. Check the actual `package.json` before every release. Do not infer a version from a filename or a previous report.

## 2. Run the repository verification gates

Use the repository’s normal checks from a clean dependency installation:

```bash
npm ci
npm run verify
npm run smoke:opencode
npm run smoke:runtime
npm run prepublishOnly
npm pack --dry-run --json
```

Interpret the checks separately:

- `npm run verify` covers typecheck, clean build, tests, package checks, and the compiled plugin smoke.
- `npm run smoke:opencode` runs the clean-XDG registry/interpolation smoke. It verifies that the real OpenCode process loads the plugin, expands the tested configuration values, and exposes `openai_image_generate` and `openai_image_edit` in the tool registry. It does not create a session, invoke either image tool, or contact an Images relay.
- `npm run smoke:runtime` runs the deterministic real-OpenCode session smoke. It uses loopback fake agent and Images relays to invoke both generate and edit, verify the session tool parts, request protocol, outputs, and follow-up model result. It is no-cost runtime evidence, not real external-supplier E2E.
- `npm run prepublishOnly` repeats the package’s prepublish validation without publishing.
- `npm pack --dry-run --json` is the package-content review; confirm that the linked public documents are present and source, tests, scripts, lockfiles, Deepwork state, local research, and secrets are absent as intended.

Record command names, exit status, test/assertion counts, package file count, and the OpenCode version. Do not paste environment dumps or secret-bearing command output.

## 3. Isolate-install the packed tarball

The tarball must be tested outside the repository and outside the development dependency tree. Use a new temporary directory and remove it after the check:

```bash
set -euo pipefail
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

tarball_name="$(npm pack --silent --pack-destination "$tmp_dir")"
tarball="$tmp_dir/$tarball_name"
test -f "$tarball"

app_dir="$tmp_dir/app"
mkdir -p "$app_dir"
(
  cd "$app_dir"
  npm init --yes >/dev/null
  npm install --ignore-scripts --no-package-lock --no-audit --no-fund "$tarball" @opencode-ai/plugin@1.18.4
)

package_dir="$app_dir/node_modules/opencode-openai-images"
for file in dist/index.js README.md README.zh-CN.md docs/release.md; do
  test -f "$package_dir/$file"
done
tar -tzf "$tarball"
```

Review the tar listing for the expected entrypoint, README, `README.zh-CN.md`, `docs/release.md`, governance files, and `CHANGELOG.md`. Confirm that the isolated installation resolves the package entrypoint and that no unapproved files or credentials are included. This check is not a substitute for the real OpenCode runtime smoke.

## 4. Run the deterministic runtime smoke

The release candidate needs a no-cost, deterministic runtime smoke that invokes the tools through a real OpenCode `1.18.4` process, not only through a direct module import or registry inspection. The approved design is:

1. Start a loopback-only fake agent-model relay that returns deterministic tool calls.
2. Start a separate loopback-only fake OpenAI Images-compatible relay that records and answers generation and edit requests.
3. Start OpenCode `1.18.4` with clean XDG/config directories and the local compiled plugin tuple.
4. Confirm the live tool schema, then submit a real session through the supported OpenCode session/API or CLI path.
5. Exercise both `openai_image_generate` and `openai_image_edit`.
6. Assert completed tool parts, the expected fake Images request and multipart order, valid image artifacts, metadata, and the follow-up model request containing the tool result.

Run `npm run smoke:runtime` for this gate. Keep child processes, ports, XDG directories, probe files, and outputs isolated; the command cleans them up unconditionally. The smoke uses dummy credentials, loopback binding, strict timeouts, and no external network. Do not relabel the separate registry/interpolation result from `npm run smoke:opencode` as session invocation evidence.

## 5. Complete real supplier generation/edit E2E

This gate requires explicit human approval before any paid or quota-consuming request. The release owner must confirm that the selected supplier and model actually support the required Images endpoints and fields.

Run both of these against the real configured connection:

- one minimal generation request using `openai_image_generate`;
- one edit request using `openai_image_edit`, including the intended reference-image and mask behavior when those capabilities are part of the release claim.

Verify the exact API root, model, authentication behavior, request fields, response asset form, image magic/MIME/dimensions, output containment, metadata, and error handling. Prefer small test images and prompts. Treat timeouts, aborts, and ambiguous provider failures as potentially billed; the plugin does not automatically retry image POST requests.

Do not put provider names, private URLs, model credentials, response bodies containing secrets, or account identifiers in the release record. Record only the redacted outcome, the tested capability, safe status/request identifiers where available, and any compatibility limitation. If either generation or edit E2E is missing, the release tag and npm publication remain blocked.

## 6. Align version and changelog

After the runtime and supplier gates pass, review the release metadata as one unit:

1. The `package.json` `name` and `version` match the intended release.
2. `CHANGELOG.md` has a reviewed entry for that exact version and accurately describes the evidence and remaining boundaries.
3. `README.md` and `README.zh-CN.md` state the same release/install status, including whether npm publication has occurred.
4. The package tarball and isolated install expose the same version and entrypoint.
5. The target version is not present in the npm registry and the corresponding Git tag does not already exist locally or remotely.

For a `0.1.0` release, the exact package specifier and tag are `opencode-openai-images@0.1.0` and `v0.1.0`. Never overwrite, republish, or reinterpret an existing `name@version`.

## 7. Commit and push approval gates

Source publication and package release are separate decisions.

### Commit approval

Present the exact proposed commit message and exact file list for human review. Commit only after explicit approval. Before committing, re-check the complete diff, staged file list, package contents, and secret scan. A documentation or code check passing does not imply commit approval.

### Push approval

After the commit is created, report the exact commit hash, branch, remote, and commits that would be pushed. Obtain a separate explicit push approval. Push only that approved commit set; do not force-push or rewrite shared history.

Do not create the release tag merely because the source commit was pushed. Tag approval is a separate gate.

## 8. Tag approval

Before creating a tag, verify again:

- all required verification gates passed on the exact commit;
- deterministic runtime invocation smoke passed;
- real generation and edit E2E passed with approval;
- version and `CHANGELOG.md` are aligned;
- the tag name is unused locally and on the remote;
- the source commit is already pushed to the intended repository.

Present the exact tag name, target commit, and annotated tag message for approval. Only after approval may the release owner create and push the tag, for example `v0.1.0`. No script or CI job may create tags implicitly.

## 9. GitHub Release approval

After the approved tag is visible on the intended repository, present the proposed GitHub Release title, tag, prerelease status, and notes. Use the reviewed `CHANGELOG.md` entry; do not claim external supplier support or npm availability that the evidence does not prove. Create the GitHub Release only after a separate human approval. Do not enable an automatic “publish release” workflow as a side effect of this SOP.

## 10. Choose npm authentication: 2FA or Trusted Publishing

Choose one reviewed authentication path before requesting publish approval. Do not combine them casually or store a long-lived token for convenience.

### Interactive npm 2FA

- Confirm the maintainer account, package ownership, registry, access level, and 2FA policy interactively.
- Use the one-time OTP only at the interactive publish prompt or approved command.
- Never write the OTP, npm token, password, or `npmrc` contents to a file, log, issue, artifact, or release note.
- Remove temporary auth configuration after the operation and verify that no credential-bearing environment variable or file is part of the package or workspace evidence.

### npm Trusted Publishing

- Use npm’s OIDC-based Trusted Publishing only if the exact GitHub repository, workflow, ref/environment policy, permissions, and provenance behavior have been reviewed and separately approved.
- Map the publisher to the exact repository and approved workflow; do not rely on a broad repository or branch wildcard without review.
- Use short-lived OIDC credentials; do not add a long-lived npm token as a fallback.
- The current release process does not authorize automatic publishing. If a Trusted Publishing workflow is not already present and approved, this path is unavailable for the release and must not be invented during the publish step.

The chosen path and its non-secret result may be recorded. Credentials and OTPs may not.

## 11. Publish approval

Before publishing, present one final release packet containing:

- exact package name and unused version;
- exact source commit, tag, and GitHub Release;
- successful verification, package, isolated-install, deterministic-runtime, and real supplier evidence, plus the pre-publish registry check that the version is unused;
- selected npm registry and authentication path;
- exact publish command or approved workflow invocation;
- explicit statement that no credentials will be recorded.

Obtain explicit human approval for that exact package/version and registry. Only then publish with the selected, reviewed npm procedure (normally public access for this package). Do not run `npm publish` automatically from a generic “all checks passed” step, and do not use an unreviewed registry or package specifier.

## 12. Registry post-publish smoke

After npm reports success, verify the public registry before declaring the release complete:

```bash
npm view opencode-openai-images@0.1.0 version dist.tarball dist.integrity
post_dir="$(mktemp -d)"
trap 'rm -rf "$post_dir"' EXIT

app_dir="$post_dir/app"
mkdir -p "$app_dir"
(
  cd "$app_dir"
  npm init --yes >/dev/null
  npm install --ignore-scripts --no-package-lock --no-audit --no-fund "opencode-openai-images@0.1.0" @opencode-ai/plugin@1.18.4
)

package_dir="$app_dir/node_modules/opencode-openai-images"
for file in dist/index.js README.md README.zh-CN.md docs/release.md; do
  test -f "$package_dir/$file"
done
```

In a clean, isolated OpenCode `1.18.4` configuration, use the exact tuple specifier `opencode-openai-images@0.1.0` and confirm package resolution plus tool registry visibility. Do not invent or document an `opencode plugin` CLI flow. This post-publish smoke proves registry availability and package installation; it does not replace real supplier generation/edit E2E.

Record the public version, tarball URL, integrity value, registry response status, and smoke result. Redact credentials, private URLs, local paths, and account data.

## Release evidence and stop conditions

The final release record should distinguish at least:

- repository tests and contract evidence;
- fake-relay full plugin-chain evidence;
- real OpenCode tool-registry evidence;
- deterministic real-OpenCode invocation against local fake relays;
- real external-provider generation and edit evidence;
- package/tarball and registry installation evidence;
- human approvals for commit, push, tag, GitHub Release, and npm publication.

If any required evidence is absent, stale, tied to a different commit/version, or contains an unresolved security or billing ambiguity, the release is not complete. Leave the package unpublished and the tag uncreated until the missing evidence or approval is resolved.
