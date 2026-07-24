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
      "LICENSE",
      "CONTRIBUTING.md",
      "CODE_OF_CONDUCT.md",
      "SECURITY.md",
      "CHANGELOG.md",
      "package.json",
    ]);
    for (const file of [
      "README.md",
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
    ]) {
      expect(existsSync(resolve(root, file))).toBe(true);
    }
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
