import { describe, expect, test } from "bun:test";
import {
  createOpenAIImagesTransport,
  MAX_SUCCESS_RESPONSE_BYTES,
  ImagesTransportAbortError,
  ImagesTransportHttpError,
  ImagesTransportInputError,
  ImagesTransportResponseError,
  ImagesTransportTimeoutError,
  type EditImageRequest,
  type GenerateImageRequest,
  type PreparedImageInput,
} from "../src/protocol/openai-images/index.js";
import type { ResolvedTransportTarget } from "../src/config/types.js";

const target: ResolvedTransportTarget = {
  name: "relay",
  baseURL: "https://images.example.test/custom/prefix///",
  model: "configured-model",
  apiKey: "api-secret",
  headers: { "X-Custom": "custom-secret" },
  timeoutMs: 600_000,
};

const signal = () => new AbortController().signal;

function response(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function prepared(filename: string, mimeType = "image/png"): PreparedImageInput {
  return { bytes: new Uint8Array([1, 2, 3, 4]), filename, mimeType };
}

function stalledResponse(status: number): Response {
  const prefix = status >= 400 ? "{\"error\":{" : "{\"data\":[";
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(prefix));
    },
  }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function failingResponse(status: number): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new TypeError("sensitive raw stream failure"));
    },
  }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("OpenAI Images transport request construction", () => {
  test("builds generation JSON at the exact API root and omits undefined fields", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = { url: String(input), init: init ?? {} };
      return response({ data: [{ b64_json: "encoded" }] });
    };
    const request: GenerateImageRequest = {
      prompt: "a test image",
      size: "2048x2048",
      quality: "cinematic",
      outputFormat: "png",
      outputCompression: undefined,
    };

    const result = await createOpenAIImagesTransport({ fetch: fetchImpl }).generate(request, target, signal());
    expect(captured?.url).toBe("https://images.example.test/custom/prefix/images/generations");
    expect(captured?.init.method).toBe("POST");
    const headers = new Headers(captured?.init.headers);
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("authorization")).toBe("Bearer api-secret");
    expect(headers.get("x-custom")).toBe("custom-secret");
    expect(JSON.parse(String(captured?.init.body))).toEqual({
      model: "configured-model",
      prompt: "a test image",
      n: 1,
      size: "2048x2048",
      quality: "cinematic",
      output_format: "png",
    });
    expect(result.assets).toEqual([{ kind: "base64", value: "encoded" }]);
  });

  test("builds multipart edits with repeated image[] files and no local path access", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = { url: String(input), init: init ?? {} };
      return response({ data: [{ url: "https://cdn.example.test/edited.png" }] });
    };
    const request: EditImageRequest = {
      prompt: "combine the subject and reference",
      images: [prepared("subject.png"), prepared("reference.jpg", "image/jpeg")],
      mask: prepared("mask.png"),
      size: "custom-wide",
      quality: "high",
      background: "transparent",
      outputFormat: "webp",
      outputCompression: 70,
      moderation: "low",
      inputFidelity: "high",
    };

    const result = await createOpenAIImagesTransport({ fetch: fetchImpl }).edit(request, target, signal());
    expect(captured?.url).toBe("https://images.example.test/custom/prefix/images/edits");
    expect(captured?.init.method).toBe("POST");
    const headers = new Headers(captured?.init.headers);
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("authorization")).toBe("Bearer api-secret");
    expect(headers.get("content-type")).toBeNull();

    const form = captured?.init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("model")).toBe("configured-model");
    expect(form.get("prompt")).toBe("combine the subject and reference");
    expect(form.get("n")).toBe("1");
    expect(form.get("size")).toBe("custom-wide");
    expect(form.get("quality")).toBe("high");
    expect(form.get("background")).toBe("transparent");
    expect(form.get("output_format")).toBe("webp");
    expect(form.get("output_compression")).toBe("70");
    expect(form.get("moderation")).toBe("low");
    expect(form.get("input_fidelity")).toBe("high");
    expect(form.getAll("image[]")).toHaveLength(2);
    expect((form.getAll("image[]")[0] as File).name).toBe("subject.png");
    expect((form.getAll("image[]")[1] as File).name).toBe("reference.jpg");
    expect(new Uint8Array(await (form.getAll("image[]")[0] as File).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect((form.get("mask") as File).name).toBe("mask.png");
    expect(result.assets[0]).toEqual({ kind: "url", value: "https://cdn.example.test/edited.png" });

    const requestWithBoundary = new Request(captured!.url, captured!.init);
    expect(requestWithBoundary.headers.get("content-type")).toMatch(/^multipart\/form-data; boundary=/);
  });

  test("rejects unprepared edit paths without reading them", async () => {
    const fetchImpl = async () => response({ data: [{ b64_json: "never-called" }] });
    const request: EditImageRequest = { prompt: "edit", images: ["workspace/input.png" as unknown as PreparedImageInput] };

    await expect(createOpenAIImagesTransport({ fetch: fetchImpl }).edit(request, target, signal()))
      .rejects.toBeInstanceOf(ImagesTransportInputError);
  });
});

describe("OpenAI Images transport response normalization", () => {
  test("normalizes b64_json, data URLs, ordinary URLs, and revised prompt metadata", async () => {
    const fetchImpl = async () => response({
      data: [
        { b64_json: "encoded", revised_prompt: "revised once" },
        { url: "data:image/png;base64,AAAA" },
        { url: "https://cdn.example.test/result.png" },
      ],
    });
    const result = await createOpenAIImagesTransport({ fetch: fetchImpl }).generate({ prompt: "make it" }, target, signal());

    expect(result).toEqual({
      assets: [
        { kind: "base64", value: "encoded" },
        { kind: "data-url", value: "data:image/png;base64,AAAA", mimeType: "image/png" },
        { kind: "url", value: "https://cdn.example.test/result.png" },
      ],
      revisedPrompt: "revised once",
    });
  });

  test("rejects bad JSON, empty data, unknown items, and unsupported URLs", async () => {
    const cases: Array<{ body: unknown; message: string }> = [
      { body: "not-json", message: "not valid JSON" },
      { body: { data: [] }, message: "non-empty data array" },
      { body: { data: [{}] }, message: "no supported image asset" },
      { body: { data: [{ url: "file:///tmp/image.png" }] }, message: "unsupported image URL" },
    ];
    for (const current of cases) {
      const fetchImpl = async () => response(current.body);
      await expect(createOpenAIImagesTransport({ fetch: fetchImpl }).generate({ prompt: "make it" }, target, signal()))
        .rejects.toMatchObject({ code: "INVALID_RESPONSE", message: expect.stringContaining(current.message) });
    }
  });
});

describe("OpenAI Images transport errors and cancellation", () => {
  test("returns structured redacted provider errors and never retries billed POSTs", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return response({
        error: {
          code: "rate_limit",
          type: "provider_rate_limit",
          message: "api-secret custom-secret should not escape",
        },
      }, 429, { "x-request-id": "request-429" });
    };
    const error = await createOpenAIImagesTransport({ fetch: fetchImpl }).generate({ prompt: "make it" }, target, signal())
      .catch((value: unknown) => value);

    expect(error).toBeInstanceOf(ImagesTransportHttpError);
    expect(error).toMatchObject({
      code: "HTTP_ERROR",
      status: 429,
      providerCode: "rate_limit",
      providerType: "provider_rate_limit",
      requestId: "request-429",
    });
    expect((error as Error).message).not.toContain("api-secret");
    expect((error as Error).message).not.toContain("custom-secret");
    expect(calls).toBe(1);
  });

  test("classifies 401, 429, and 5xx responses as HTTP errors", async () => {
    for (const status of [401, 429, 503]) {
      const fetchImpl = async () => response({ error: { code: `status_${status}`, type: "upstream", message: "denied" } }, status);
      await expect(createOpenAIImagesTransport({ fetch: fetchImpl }).generate({ prompt: "make it" }, target, signal()))
        .rejects.toMatchObject({ code: "HTTP_ERROR", status, providerCode: `status_${status}` });
    }
  });

  test("distinguishes caller abort from timeout and cleans up cancellation", async () => {
    const abortableFetch = async (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const requestSignal = init?.signal;
      requestSignal?.addEventListener("abort", () => reject(requestSignal.reason ?? new DOMException("Aborted", "AbortError")), { once: true });
    });
    const controller = new AbortController();
    const abortPromise = createOpenAIImagesTransport({ fetch: abortableFetch }).generate({ prompt: "make it" }, target, controller.signal);
    controller.abort();
    await expect(abortPromise).rejects.toBeInstanceOf(ImagesTransportAbortError);

    const timeoutTarget = { ...target, timeoutMs: 5 };
    const timeoutPromise = createOpenAIImagesTransport({ fetch: abortableFetch }).generate({ prompt: "make it" }, timeoutTarget, signal());
    await expect(timeoutPromise).rejects.toBeInstanceOf(ImagesTransportTimeoutError);
  });

  test("classifies success and HTTP error body stalls after headers as timeout or caller abort", async () => {
    const successTimeout = createOpenAIImagesTransport({ fetch: async () => stalledResponse(200) })
      .generate({ prompt: "stall" }, { ...target, timeoutMs: 5 }, signal());
    await expect(successTimeout).rejects.toBeInstanceOf(ImagesTransportTimeoutError);

    const caller = new AbortController();
    const successAbort = createOpenAIImagesTransport({ fetch: async () => stalledResponse(200) })
      .generate({ prompt: "stall" }, target, caller.signal);
    caller.abort();
    await expect(successAbort).rejects.toBeInstanceOf(ImagesTransportAbortError);

    const errorTimeout = createOpenAIImagesTransport({ fetch: async () => stalledResponse(503) })
      .generate({ prompt: "stall" }, { ...target, timeoutMs: 5 }, signal());
    await expect(errorTimeout).rejects.toBeInstanceOf(ImagesTransportTimeoutError);
  });

  test("enforces the success response byte limit before JSON.parse", async () => {
    let calls = 0;
    const contentLength = createOpenAIImagesTransport({
      successBodyLimitBytes: 32,
      fetch: async () => {
        calls += 1;
        return response("{}", 200, { "content-length": "33" });
      },
    });
    await expect(contentLength.generate({ prompt: "large" }, target, signal())).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(calls).toBe(1);

    let chunks = 0;
    const overflow = createOpenAIImagesTransport({
      successBodyLimitBytes: 32,
      fetch: async () => new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          chunks += 1;
          controller.enqueue(new TextEncoder().encode("x".repeat(20)));
          if (chunks >= 2) controller.close();
        },
      }), { status: 200, headers: { "content-type": "application/json" } }),
    });
    await expect(overflow.generate({ prompt: "large" }, target, signal())).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(chunks).toBeLessThanOrEqual(2);
    expect(MAX_SUCCESS_RESPONSE_BYTES).toBeGreaterThan(50 * 1024 * 1024);
  });

  test("maps non-abort success and HTTP error stream failures without raw exceptions", async () => {
    const success = createOpenAIImagesTransport({ fetch: async () => failingResponse(200) })
      .generate({ prompt: "stream failure" }, target, signal());
    const successError = await success.catch((value: unknown) => value as { code: string; message: string });
    expect(successError).toMatchObject({ code: "INVALID_RESPONSE", message: "Unable to read the response body." });
    expect(successError.message).not.toContain("sensitive raw stream failure");

    const httpError = createOpenAIImagesTransport({ fetch: async () => failingResponse(502) })
      .generate({ prompt: "stream failure" }, target, signal());
    const httpErrorValue = await httpError.catch((value: unknown) => value as { code: string; message: string });
    expect(httpErrorValue).toMatchObject({ code: "INVALID_RESPONSE", message: "Unable to read the response body." });
    expect(httpErrorValue.message).not.toContain("sensitive raw stream failure");
  });

  test("does not parse or echo truncated HTTP error bodies across secret boundaries", async () => {
    const secret = "SUPER-LONG-API-SECRET-".repeat(20);
    const body = JSON.stringify({ error: { message: `${"x".repeat(8_180)}${secret}`, code: secret, type: secret } });
    const error = await createOpenAIImagesTransport({
      errorBodyLimitBytes: 8 * 1024,
      fetch: async () => response(body, 500, { "x-request-id": "safe-request-id" }),
    }).generate({ prompt: "truncated" }, target, signal()).catch((value: unknown) => value as {
      code: string;
      message: string;
      providerCode?: string;
      providerType?: string;
      requestId?: string;
    });

    expect(error).toMatchObject({ code: "HTTP_ERROR", requestId: "safe-request-id" });
    expect(error.message).toBe("Upstream error response body was truncated; provider error details unavailable.");
    expect(error.message).not.toContain(secret.slice(0, 16));
    expect(error.providerCode).toBeUndefined();
    expect(error.providerType).toBeUndefined();
  });

  test("redacts complete long secrets before clipping provider fields", async () => {
    const longApiKey = "A".repeat(200);
    const longHeader = "B".repeat(200);
    const longTarget: ResolvedTransportTarget = {
      ...target,
      apiKey: longApiKey,
      headers: { "X-Secret": longHeader },
    };
    const fetchImpl = async () => response({
      error: {
        message: `${"prefix ".repeat(150)}${longApiKey}`,
        code: longHeader,
        type: longApiKey,
      },
    }, 500, { "x-request-id": longHeader });
    const error = await createOpenAIImagesTransport({ fetch: fetchImpl }).generate({ prompt: "redact" }, longTarget, signal())
      .catch((value: unknown) => value as { message: string; providerCode?: string; providerType?: string; requestId?: string });

    expect(error.message).not.toContain(longApiKey.slice(0, 32));
    expect(error.message).not.toContain(longHeader.slice(0, 32));
    expect(error.providerCode).not.toContain(longHeader.slice(0, 32));
    expect(error.providerType).not.toContain(longApiKey.slice(0, 32));
    expect(error.requestId).not.toContain(longHeader.slice(0, 32));
  });
});
