import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const root = process.cwd();
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("package check must run through an npm lifecycle script");
const raw = execFileSync(process.execPath, [npmCli, "pack", "--dry-run", "--json"], {
  cwd: root,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
const report = JSON.parse(raw);
const files = new Set(report[0]?.files?.map((entry) => entry.path) ?? []);

const required = ["dist/index.js", "dist/index.d.ts", "package.json"];
for (const file of required) {
  if (!files.has(file)) throw new Error(`package check failed: missing ${file}`);
}

const requiredReleaseFiles = [
  "README.md",
  "README.zh-CN.md",
  "LICENSE",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "SECURITY.md",
  "CHANGELOG.md",
  "docs/configuration.md",
  "docs/protocol-compatibility.md",
  "docs/security.md",
  "docs/troubleshooting.md",
  "docs/recipes/new-api-cliproxyapi.md",
  "docs/release.md",
];
for (const file of requiredReleaseFiles) {
  if (!existsSync(resolve(root, file))) throw new Error(`package check failed: missing release file ${file}`);
  if (!files.has(file)) throw new Error(`package check failed: ${file} exists but is absent from tarball`);
}

const forbidden = [
  /^(?:src|test|scripts)\//u,
  /^docs\/(?:internal|private|draft)\//iu,
  /^\.slim\//u,
  /(?:openai-image-api\.zip|opencode-gpt-image-2-research-.*\.md)$/u,
  /(?:^|\/)(?:\.env(?:\.|$)|.*\.(?:pem|key|p12))$/iu,
  /^package-lock\.json$/u,
];
for (const file of files) {
  if (forbidden.some((pattern) => pattern.test(file))) {
    throw new Error(`package check failed: forbidden package entry ${file}`);
  }
}

console.log(`PACKAGE_CHECK_OK: ${files.size} files; entry ${packageJson.name}@${packageJson.version}`);
