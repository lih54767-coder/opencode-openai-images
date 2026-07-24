import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "../..");

function sourceFiles(directory: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...sourceFiles(path));
    else if (entry.name.endsWith(".ts")) result.push(path);
  }
  return result;
}

describe("release metadata", () => {
  test("declares the intended package identity and compatibility", () => {
    const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    expect(packageJson.name).toBe("opencode-openai-images");
    expect(packageJson.license).toBe("MIT");
    expect(packageJson.author.name).toBe("lih54767-coder");
    expect(packageJson.repository.url).toContain("github.com/lih54767-coder/opencode-openai-images");
    expect(packageJson.bugs.url).toContain("/issues");
    expect(packageJson.homepage).toContain("github.com/lih54767-coder/opencode-openai-images");
    expect(packageJson.engines.node).toBe(">=20");
    expect(packageJson.engines.opencode).toBe(">=1.18.4 <2");
    expect(packageJson.peerDependencies["@opencode-ai/plugin"]).toBe(">=1.18.4 <2");
    expect(packageJson.sideEffects).toBe(false);
    expect(packageJson.publishConfig).toEqual({ access: "public" });
    expect(packageJson.exports["."].import).toBe("./dist/index.js");
    expect(packageJson.exports["."].types).toBe("./dist/index.d.ts");
    expect(packageJson.files).toEqual([
      "dist",
      "docs",
      "README.md",
      "README.zh-CN.md",
      "LICENSE",
      "CONTRIBUTING.md",
      "CODE_OF_CONDUCT.md",
      "SECURITY.md",
      "CHANGELOG.md",
      "package.json",
    ]);
    for (const file of [
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
    ]) {
      expect(existsSync(resolve(root, file))).toBe(true);
    }
    expect(packageJson.scripts["smoke:runtime"]).toBe("npm run build && node scripts/smoke-opencode-runtime.mjs");
    expect(existsSync(resolve(root, "scripts/smoke-opencode-runtime.mjs"))).toBe(true);
  });

  test("keeps CI and tag package smoke gates explicit and non-publishing", () => {
    const ciPath = resolve(root, ".github/workflows/ci.yml");
    const packageSmokePath = resolve(root, ".github/workflows/package-smoke.yml");
    expect(existsSync(ciPath)).toBe(true);
    expect(existsSync(packageSmokePath)).toBe(true);

    const ci = readFileSync(ciPath, "utf8");
    expect(ci).toContain("actions/checkout@v5");
    expect(ci).toContain("actions/setup-node@v5");
    expect(ci).not.toMatch(/actions\/(?:checkout|setup-node)@v4/iu);
    expect(ci).toContain("oven-sh/setup-bun@v2.2.0");
    expect(ci).toContain("node-version: 22");
    expect(ci).toContain("bun-version: 1.3.14");
    expect(ci.indexOf("npm run smoke:opencode")).toBeLessThan(ci.indexOf("npm run smoke:runtime"));
    const crossPlatformJob = ci.slice(ci.indexOf("  verify:"), ci.indexOf("  opencode-smoke:"));
    expect(crossPlatformJob).not.toContain("smoke:runtime");

    const packageSmoke = readFileSync(packageSmokePath, "utf8");
    expect(packageSmoke).toMatch(/push:\s*\n\s+tags:\s*\n\s+- ["']v\*["']/u);
    expect(packageSmoke).toContain("workflow_dispatch:");
    expect(packageSmoke).toContain("permissions:");
    expect(packageSmoke).toContain("contents: read");
    expect(packageSmoke).toContain("node-version: 22");
    expect(packageSmoke).toContain("bun-version: 1.3.14");
    expect(packageSmoke).toContain("opencode-ai@1.18.4");
    expect(packageSmoke).toContain("npm run verify");
    expect(packageSmoke).toContain("npm run prepublishOnly");
    expect(packageSmoke).toContain("npm run smoke:opencode");
    expect(packageSmoke).toContain("npm run smoke:runtime");
    expect(packageSmoke).toContain("GITHUB_REF_TYPE");
    expect(packageSmoke).toContain("GITHUB_REF_NAME#v");
    expect(packageSmoke).toContain("README.zh-CN.md");
    expect(packageSmoke).toContain("docs/release.md");
    expect(packageSmoke).not.toContain("--legacy-peer-deps");
    expect(packageSmoke).not.toMatch(/id-token:\s*write|npm\s+publish|git\s+push|git\s+tag|gh\s+release/iu);
  });

  test("has no real provider endpoint or ChatGPT/Codex transport constants in source", () => {
    const source = sourceFiles(resolve(root, "src")).map((file) => readFileSync(file, "utf8")).join("\n");
    expect(source).not.toMatch(/api\.openai\.com|chatgpt|codex/iu);
  });

  test("compiled npm root exposes only the PluginModule default", async () => {
    const entry = resolve(root, "dist/index.js");
    expect(existsSync(entry)).toBe(true);
    const namespace = await import(pathToFileURL(entry).href);
    expect(Object.keys(namespace)).toEqual(["default"]);
    expect(namespace.default).toMatchObject({ id: "opencode-openai-images" });
    expect(typeof namespace.default.server).toBe("function");
  });
});
