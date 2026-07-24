import { describe, expect, test } from "bun:test";
import pluginModule from "../src/index.js";
import { parsePluginConfig } from "../src/config/index.js";
import { createImageTools } from "../src/tools/index.js";
import type { ImagesTransport } from "../src/protocol/openai-images/index.js";

const context = {
  sessionID: "session",
  messageID: "message",
  agent: "agent",
  directory: "/workspace",
  worktree: "/workspace",
  abort: new AbortController().signal,
  metadata: () => undefined,
  ask: async () => undefined,
};

function makeConfig() {
  return parsePluginConfig({
    connections: {
      primary: {
        baseURL: "https://relay.example.test/api/v1",
        model: "configured-image-model",
        description: "Primary image relay",
        apiKey: "secret-key",
        headers: { "X-Relay": "primary" },
      },
      fallback: {
        baseURL: "https://fallback.example.test/images",
        model: "fallback-model",
        description: "Fallback relay",
        capabilities: { edit: false, mask: false },
      },
    },
    defaultConnection: "primary",
  });
}

function idleTransport(): ImagesTransport {
  return {
    async generate() {
      return { assets: [] };
    },
    async edit() {
      return { assets: [] };
    },
  };
}

describe("OpenCode loader", () => {
  test("registers both tools through the real runtime entrypoint", async () => {
    const moduleNamespace = await import("../src/index.js");
    expect(Object.keys(moduleNamespace)).toEqual(["default"]);
    expect(Object.keys(pluginModule)).toEqual(["id", "server"]);
    expect(pluginModule.id).toBe("opencode-openai-images");
    const hooks = await pluginModule.server({} as never, {
      connections: { primary: { baseURL: "https://relay.example.test", model: "model" } },
    });
    expect(Object.keys(hooks.tool ?? {})).toEqual(["openai_image_generate", "openai_image_edit"]);
  });
});

describe("image tools", () => {
  test("dynamically enumerates connections without exposing endpoint secrets", () => {
    const tools = createImageTools(makeConfig(), { transport: idleTransport() });
    const connectionDescription = tools.generate.args.connection.description;

    expect(tools.generate.args.connection.safeParse("primary").success).toBe(true);
    expect(tools.generate.args.connection.safeParse("fallback").success).toBe(true);
    expect(tools.generate.args.connection.safeParse("unknown").success).toBe(false);
    expect(connectionDescription).toContain("default: primary");
    expect(connectionDescription).toContain("primary — Primary image relay");
    expect(connectionDescription).toContain("fallback — Fallback relay");
    expect(connectionDescription).toContain("edit=no");
    expect(connectionDescription).toContain("mask=no");
    expect(connectionDescription).not.toContain("relay.example.test");
    expect(connectionDescription).not.toContain("secret-key");
    expect(connectionDescription).not.toContain("X-Relay");
  });

  test("descriptions distinguish generation, editing, reference images, masks, and analysis", () => {
    const tools = createImageTools(makeConfig(), { transport: idleTransport() });

    expect(tools.generate.description).toContain("does not accept input images");
    expect(tools.generate.description).toContain("reference-guided creation belongs to the edit tool");
    expect(tools.generate.description).toContain("Do not use it for analyzing");
    expect(tools.edit.description).toContain("reference-guided creation");
    expect(tools.edit.description).toContain("mask applies to the first image");
    expect(tools.edit.description).toContain("multiple images");
    expect(tools.edit.description).toContain("roles and order");
    expect(tools.edit.description).toContain("Do not use it for analyzing");
  });

  test("enforces flexible parameters and the sixteen-image schema limit", () => {
    const tools = createImageTools(makeConfig(), { transport: idleTransport() });
    expect(tools.generate.args.size.safeParse("2048x2048").success).toBe(true);
    expect(tools.generate.args.quality.safeParse("cinematic").success).toBe(true);
    expect(tools.edit.args.images.safeParse(Array.from({ length: 16 }, () => "input.png")).success).toBe(true);
    expect(tools.edit.args.images.safeParse(Array.from({ length: 17 }, () => "input.png")).success).toBe(false);
    expect(tools.generate.args.inputFidelity).toBeUndefined();
  });

  test("rejects incompatible compression before calling transport", async () => {
    let calls = 0;
    const transport: ImagesTransport = {
      async generate() {
        calls += 1;
        return { assets: [] };
      },
      async edit() {
        calls += 1;
        return { assets: [] };
      },
    };
    const tools = createImageTools(parsePluginConfig({
      connections: {
        primary: { baseURL: "https://relay.example.test", model: "model" },
      },
    }), { transport });
    const result = await tools.generate.execute({ prompt: "make", outputFormat: "png", outputCompression: 50 }, context);
    expect(result).toMatchObject({ metadata: { code: "INVALID_ARGUMENT" } });
    expect(calls).toBe(0);
  });

  test("rejects disabled edit capability before preparing inputs or calling transport", async () => {
    let calls = 0;
    const transport: ImagesTransport = {
      async generate() {
        calls += 1;
        return { assets: [] };
      },
      async edit() {
        calls += 1;
        return { assets: [] };
      },
    };
    const tools = createImageTools(makeConfig(), { transport });
    const result = await tools.edit.execute({ prompt: "edit", images: ["missing.png"], connection: "fallback" }, context);
    expect(result).toMatchObject({ metadata: { code: "CAPABILITY_UNAVAILABLE", capability: "edit" } });
    expect(calls).toBe(0);
  });
});
