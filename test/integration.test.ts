import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parsePluginConfig } from "../src/config/index.js";
import { createOpenAIImagesTransport } from "../src/protocol/openai-images/index.js";
import { createImageTools } from "../src/tools/index.js";
import type { ImageToolDependencies } from "../src/tools/image-tools.js";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const PNG_BYTES = Uint8Array.from(Buffer.from(PNG_BASE64, "base64"));

type RelayMode = "base64" | "multiple" | "url" | "error" | "wait";

function makeConfig(timeoutMs = 600_000) {
  return parsePluginConfig({
    connections: {
      primary: {
        baseURL: "https://relay.example.test/api/prefix///",
        model: "model/v1._-",
        apiKey: "api-key-value",
        headers: { "X-Custom": "custom-header-value" },
        timeoutMs,
      },
      noMask: {
        baseURL: "https://relay.example.test/other",
        model: "model-no-mask",
        capabilities: { edit: true, mask: false },
      },
    },
    defaultConnection: "primary",
  });
}

function context(directory: string, abort = new AbortController().signal) {
  return {
    sessionID: "session",
    messageID: "message",
    agent: "agent",
    directory,
    worktree: directory,
    abort,
    metadata: () => undefined,
    ask: async () => undefined,
  };
}

function waitForAbort(init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason ?? new DOMException("Aborted", "AbortError")), { once: true });
  });
}

function makeRelay() {
  let mode: RelayMode = "base64";
  let calls = 0;
  let generationBody: Record<string, unknown> | undefined;
  let editForm: FormData | undefined;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls += 1;
    const url = String(input);
    if (mode === "wait") return waitForAbort(init);
    if (url.endsWith("/images/generations")) {
      generationBody = JSON.parse(String(init?.body));
      if (mode === "error") {
        return new Response(JSON.stringify({ error: { code: "bad_request", type: "provider", message: "api-key-value custom-header-value leaked" } }), {
          status: 401,
          headers: { "x-request-id": "req-401", "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        data: mode === "url"
          ? [{ url: "https://cdn.example.test/result.png" }]
          : mode === "multiple"
            ? [{ b64_json: PNG_BASE64, revised_prompt: "revised by relay" }, { b64_json: PNG_BASE64 }]
            : [{ b64_json: PNG_BASE64, revised_prompt: "revised by relay" }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/images/edits")) {
      editForm = init?.body as FormData;
      return new Response(JSON.stringify({ data: [{ b64_json: PNG_BASE64 }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fake relay URL: ${url}`);
  };
  return {
    fetch,
    remoteFetch: async () => new Response(PNG_BYTES, { status: 200, headers: { "content-type": "image/png" } }),
    setMode(next: RelayMode) {
      mode = next;
    },
    get calls() {
      return calls;
    },
    get generationBody() {
      return generationBody;
    },
    get editForm() {
      return editForm;
    },
  };
}

describe("full V1 tool chain with fake relay", () => {
  let workspace = "";
  let relay: ReturnType<typeof makeRelay>;
  let dependencies: ImageToolDependencies;

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "openai-images-integration-"));
    await writeFile(join(workspace, "subject.png"), PNG_BYTES);
    await writeFile(join(workspace, "reference.png"), PNG_BYTES);
    await writeFile(join(workspace, "mask.png"), PNG_BYTES);
    relay = makeRelay();
    dependencies = {
      transport: createOpenAIImagesTransport({ fetch: relay.fetch }),
      remoteFetch: relay.remoteFetch,
    };
  });

  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  test("generates base64 PNG, writes metadata, and versions repeated out paths", async () => {
    relay.setMode("base64");
    const tools = createImageTools(makeConfig(), dependencies);
    const first = await tools.generate.execute({ prompt: "make an image", out: "generated/image.png" }, context(workspace));
    const second = await tools.generate.execute({ prompt: "make another image", out: "generated/image.png" }, context(workspace));

    expect(first.output).toContain(join("generated", "image.png"));
    expect(second.output).toContain(join("generated", "image-v2.png"));
    expect(first).not.toHaveProperty("attachments");
    expect(first).toMatchObject({ metadata: { code: "OK", connection: "primary", model: "model/v1._-", revisedPrompt: "revised by relay" } });
    expect((first as { metadata: { outputs: Array<Record<string, unknown>> } }).metadata.outputs[0]).toMatchObject({
      mime: "image/png", width: 1, height: 1, byteLength: PNG_BYTES.byteLength, versioned: false,
    });
    expect((second as { metadata: { outputs: Array<Record<string, unknown>> } }).metadata.outputs[0].versioned).toBe(true);
    expect(await readFile(join(workspace, "generated/image.png"))).toEqual(Buffer.from(PNG_BYTES));
    expect(relay.generationBody).toEqual({ model: "model/v1._-", prompt: "make another image", n: 1 });
  });

  test("edits prepared local images and mask, preserving multipart order", async () => {
    const tools = createImageTools(makeConfig(), dependencies);
    const result = await tools.edit.execute({
      prompt: "combine the subject and reference",
      images: ["subject.png", "reference.png"],
      mask: "mask.png",
      out: "edited/result.png",
    }, context(workspace));

    expect(result).toMatchObject({ metadata: { code: "OK", connection: "primary" } });
    expect(result.output).toContain(join("edited", "result.png"));
    expect(relay.editForm?.get("model")).toBe("model/v1._-");
    expect(relay.editForm?.get("n")).toBe("1");
    expect(relay.editForm?.getAll("image[]")).toHaveLength(2);
    expect((relay.editForm?.getAll("image[]")[0] as File).name).toBe("subject.png");
    expect((relay.editForm?.getAll("image[]")[1] as File).name).toBe("reference.png");
    expect((relay.editForm?.get("mask") as File).name).toBe("mask.png");
  });

  test("materializes multiple assets sequentially without changing n=1", async () => {
    relay.setMode("multiple");
    const tools = createImageTools(makeConfig(), dependencies);
    const result = await tools.generate.execute({ prompt: "make two relay outputs" }, context(workspace));

    expect(result.output).toContain("Generated 2 images");
    expect(result.output).toContain(join("outputs", "image.png"));
    expect(result.output).toContain(join("outputs", "image-v2.png"));
    expect(result).toMatchObject({ metadata: { revisedPrompt: "revised by relay", outputs: [{ versioned: false }, { versioned: true }] } });
    expect((result as { metadata: { outputs: unknown[] } }).metadata.outputs).toHaveLength(2);
    expect(relay.generationBody?.n).toBe(1);
  });

  test("preflights default and explicit output candidate chains for symlinks", async () => {
    const tools = createImageTools(makeConfig(), dependencies);
    const targetFile = join(workspace, "symlink-target.bin");
    await writeFile(targetFile, PNG_BYTES);
    await rm(join(workspace, "outputs"), { recursive: true, force: true });
    await mkdir(join(workspace, "outputs"));
    await symlink(targetFile, join(workspace, "outputs/image.png"));
    const firstCalls = relay.calls;
    expect(await tools.generate.execute({ prompt: "blocked default" }, context(workspace))).toMatchObject({ metadata: { code: "OUTPUT_INVALID" } });
    expect(relay.calls).toBe(firstCalls);

    await rm(join(workspace, "outputs"), { recursive: true, force: true });
    await mkdir(join(workspace, "outputs"));
    await writeFile(join(workspace, "outputs/image.png"), PNG_BYTES);
    await symlink(targetFile, join(workspace, "outputs/image-v2.png"));
    const secondCalls = relay.calls;
    expect(await tools.generate.execute({ prompt: "blocked version" }, context(workspace))).toMatchObject({ metadata: { code: "OUTPUT_INVALID" } });
    expect(relay.calls).toBe(secondCalls);

    await rm(join(workspace, "explicit"), { recursive: true, force: true });
    await mkdir(join(workspace, "explicit"));
    await writeFile(join(workspace, "explicit/image.jpeg"), PNG_BYTES);
    await symlink(targetFile, join(workspace, "explicit/image-v2.jpeg"));
    const thirdCalls = relay.calls;
    expect(await tools.generate.execute({ prompt: "blocked explicit", out: "explicit/image.jpeg" }, context(workspace))).toMatchObject({ metadata: { code: "OUTPUT_INVALID" } });
    expect(relay.calls).toBe(thirdCalls);
    await rm(join(workspace, "outputs"), { recursive: true, force: true });
    await rm(join(workspace, "explicit"), { recursive: true, force: true });
  });

  test("materializes HTTPS URL assets with the injected remote fetch", async () => {
    relay.setMode("url");
    const tools = createImageTools(makeConfig(), dependencies);
    const result = await tools.generate.execute({ prompt: "make a remote image", out: "remote/result.webp" }, context(workspace));

    expect(result.output).toContain(join("remote", "result.png"));
    expect(result).toMatchObject({ metadata: { outputs: [{ mime: "image/png", width: 1, height: 1 }] } });
  });

  test("rejects invalid compression, capabilities, count, path, and mask before HTTP", async () => {
    relay.setMode("base64");
    const tools = createImageTools(makeConfig(), dependencies);
    const before = relay.calls;

    expect(await tools.generate.execute({ prompt: "bad", outputFormat: "png", outputCompression: 10 }, context(workspace))).toMatchObject({ metadata: { code: "INVALID_ARGUMENT" } });
    expect(await tools.generate.execute({ prompt: "bad", out: "../escape.png" }, context(workspace))).toMatchObject({ metadata: { code: "OUTPUT_INVALID" } });
    expect(await tools.edit.execute({ prompt: "too many", images: Array.from({ length: 17 }, () => "subject.png") }, context(workspace))).toMatchObject({ metadata: { code: "INVALID_ARGUMENT" } });
    expect(await tools.edit.execute({ prompt: "bad mask", images: ["missing.png"], mask: "mask.png", connection: "noMask" }, context(workspace))).toMatchObject({ metadata: { code: "CAPABILITY_UNAVAILABLE", capability: "mask" } });
    expect(relay.calls).toBe(before);
  });

  test("turns provider errors, caller abort, and timeout into stable redacted results", async () => {
    relay.setMode("error");
    const tools = createImageTools(makeConfig(), dependencies);
    const providerResult = await tools.generate.execute({ prompt: "provider error" }, context(workspace));
    expect(providerResult).toMatchObject({ metadata: { code: "HTTP_ERROR", status: 401, requestId: "req-401", providerCode: "bad_request" } });
    expect(providerResult.output).not.toContain("api-key-value");
    expect(providerResult.output).not.toContain("custom-header-value");

    relay.setMode("wait");
    const controller = new AbortController();
    const abortPromise = tools.generate.execute({ prompt: "cancelled" }, context(workspace, controller.signal));
    controller.abort();
    expect(await abortPromise).toMatchObject({ metadata: { code: "ABORTED" } });

    const timeoutTools = createImageTools(makeConfig(5), { transport: createOpenAIImagesTransport({ fetch: relay.fetch }) });
    expect(await timeoutTools.generate.execute({ prompt: "timeout" }, context(workspace))).toMatchObject({ metadata: { code: "TIMEOUT" } });

    relay.setMode("url");
    const remoteTimeoutFetch: typeof globalThis.fetch = async (_input, init) => waitForAbort(init);
    const remoteTimeoutTools = createImageTools(makeConfig(5), {
      transport: createOpenAIImagesTransport({ fetch: relay.fetch }),
      remoteFetch: remoteTimeoutFetch,
    });
    expect(await remoteTimeoutTools.generate.execute({ prompt: "remote timeout" }, context(workspace))).toMatchObject({ metadata: { code: "REMOTE_TIMEOUT" } });
  });
});
