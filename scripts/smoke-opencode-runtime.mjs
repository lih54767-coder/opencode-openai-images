import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const binary = process.env.OPENCODE_BIN ?? "opencode";
const root = process.cwd();
const entry = resolve(root, "dist/index.js");
const TOTAL_TIMEOUT_MS = 90_000;
const SESSION_TIMEOUT_MS = 75_000;
const AGENT_PROVIDER = "runtime-agent";
const AGENT_MODEL = "runtime-agent-model";
const IMAGE_MODEL = "runtime-image-model";
const AGENT_API_KEY = "runtime-agent-dummy-key";
const IMAGE_API_KEY = "runtime-image-dummy-key";
const IMAGE_HEADER = "runtime-nested-header-sentinel";
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const PNG_BYTES = Buffer.from(PNG_BASE64, "base64");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeLog(value, secrets = []) {
  let text = String(value);
  for (const secret of secrets) {
    if (secret) text = text.split(secret).join("[REDACTED]");
  }
  return text;
}

async function reservePort() {
  const server = createNetServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object", "reserved port did not have a TCP address");
  const port = address.port;
  await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
  return port;
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object", "relay did not have a TCP address");
  return address.port;
}

async function closeServer(server) {
  if (!server || !server.listening) return;
  await new Promise((resolveClose) => server.close(() => resolveClose()));
}

async function readRequestBody(request, limit = 12 * 1024 * 1024) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.byteLength;
    if (length > limit) throw new Error("fake relay request exceeded the diagnostic body limit");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function jsonResponse(response, status, value) {
  const body = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json");
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(body);
}

function textResponse(response, status, value) {
  response.statusCode = status;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.end(value);
}

function toolCallFor(stage) {
  if (stage === 0) {
    return {
      name: "openai_image_generate",
      arguments: {
        prompt: "runtime generate sentinel",
        out: "generated/runtime-generate.png",
      },
    };
  }
  return {
    name: "openai_image_edit",
    arguments: {
      prompt: "runtime edit sentinel",
      images: ["generated/runtime-generate.png", "reference.png"],
      mask: "mask.png",
      out: "edited/runtime-edit.png",
    },
  };
}

function openAIChatResponse(model, stage) {
  if (stage < 2) {
    const call = toolCallFor(stage);
    return {
      id: `runtime-chat-${stage + 1}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1_000),
      model,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: `runtime-tool-call-${stage + 1}`,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.arguments) },
          }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
  }
  return {
    id: "runtime-chat-final",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1_000),
    model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: "runtime generate and edit complete" },
      finish_reason: "stop",
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function openAIChatStream(model, stage, response) {
  const full = openAIChatResponse(model, stage);
  const choice = full.choices[0];
  const delta = { role: choice.message.role };
  if (choice.message.tool_calls) delta.tool_calls = choice.message.tool_calls;
  else delta.content = choice.message.content;
  const first = {
    id: full.id,
    object: "chat.completion.chunk",
    created: full.created,
    model,
    choices: [{ index: 0, delta, finish_reason: null }],
  };
  const finish = {
    id: full.id,
    object: "chat.completion.chunk",
    created: full.created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }],
    usage: full.usage,
  };
  response.statusCode = 200;
  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache");
  response.setHeader("Connection", "keep-alive");
  response.write(`data: ${JSON.stringify(first)}\n\n`);
  response.write(`data: ${JSON.stringify(finish)}\n\n`);
  response.end("data: [DONE]\n\n");
}

function makeAgentRelay() {
  const calls = [];
  const failures = [];
  const server = createHttpServer((request, response) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        if (request.method === "GET" && url.pathname.endsWith("/models")) {
          jsonResponse(response, 200, { object: "list", data: [{ id: AGENT_MODEL, object: "model", owned_by: "runtime" }] });
          return;
        }
        if (request.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
          textResponse(response, 404, "fake agent relay only supports chat completions");
          return;
        }

        const raw = await readRequestBody(request);
        let body;
        try {
          body = JSON.parse(raw.toString("utf8"));
        } catch {
          throw new Error("fake agent relay received a non-JSON chat request");
        }
        const tools = Array.isArray(body.tools) ? body.tools : [];
        const toolNames = tools.map((tool) => tool?.function?.name ?? tool?.name).filter((name) => typeof name === "string");
        const missingTools = ["openai_image_generate", "openai_image_edit"].filter((name) => !toolNames.includes(name));
        if (missingTools.length > 0) throw new Error(`actual model request omitted tools: ${missingTools.join(", ")}`);
        const messages = Array.isArray(body.messages) ? body.messages : [];
        const toolResultCount = messages.filter((message) => message?.role === "tool").length;
        const summary = {
          path: url.pathname,
          stream: body.stream === true,
          toolNames,
          messageRoles: messages.map((message) => message?.role).filter((role) => typeof role === "string"),
          hasToolResult: toolResultCount > 0,
          toolResultCount,
        };
        calls.push(summary);
        const stage = Math.min(toolResultCount, 2);
        if (body.stream === true) openAIChatStream(AGENT_MODEL, stage, response);
        else jsonResponse(response, 200, openAIChatResponse(AGENT_MODEL, stage));
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
        jsonResponse(response, 500, { error: { message: "fake agent relay rejected the request", type: "runtime_smoke" } });
      }
    })();
  });

  return {
    server,
    async start() {
      const port = await listen(server);
      return `http://127.0.0.1:${port}/v1`;
    },
    async close() {
      await closeServer(server);
    },
    calls,
    failures,
  };
}

function parseMultipart(buffer, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/iu.exec(contentType);
  assert(match, "edit request did not include a multipart boundary");
  const boundary = match[1] ?? match[2];
  const raw = buffer.toString("latin1");
  const parts = raw.split(`--${boundary}`);
  const fields = Object.create(null);
  const files = [];
  for (const part of parts) {
    const section = part.replace(/^\r\n/u, "");
    if (section.length === 0 || section === "--\r\n" || section === "--") continue;
    const separator = section.indexOf("\r\n\r\n");
    if (separator < 0) continue;
    const headerText = section.slice(0, separator);
    let value = section.slice(separator + 4);
    if (value.endsWith("\r\n")) value = value.slice(0, -2);
    const name = /(?:^|\r\n)content-disposition:[^\r\n]*\bname="([^"]+)"/iu.exec(headerText)?.[1];
    if (!name) continue;
    const filename = /\bfilename="([^"]*)"/iu.exec(headerText)?.[1];
    if (filename !== undefined) files.push({ name, filename, byteLength: Buffer.byteLength(value, "latin1") });
    else fields[name] = value;
  }
  return { fields, files };
}

function makeImagesRelay() {
  const requests = [];
  const failures = [];
  const server = createHttpServer((request, response) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        const authorization = request.headers.authorization;
        const nestedHeader = request.headers["x-runtime-nested-header"];
        assert(authorization === `Bearer ${IMAGE_API_KEY}`, "images relay did not receive the interpolated apiKey");
        assert(nestedHeader === IMAGE_HEADER, "images relay did not receive the interpolated nested header");
        const raw = await readRequestBody(request);
        if (request.method !== "POST" || !["/images/generations", "/images/edits"].includes(url.pathname)) {
          textResponse(response, 404, "fake images relay only supports generations and edits");
          return;
        }
        if (url.pathname === "/images/generations") {
          let body;
          try {
            body = JSON.parse(raw.toString("utf8"));
          } catch {
            throw new Error("generation request was not JSON");
          }
          assert(body.model === IMAGE_MODEL, "generation request model did not reach the images relay");
          assert(body.prompt === "runtime generate sentinel", "generation request prompt did not reach the images relay");
          assert(body.n === 1, "generation request must keep n=1");
          requests.push({ kind: "generation", body: { model: body.model, prompt: body.prompt, n: body.n } });
        } else {
          const parsed = parseMultipart(raw, String(request.headers["content-type"] ?? ""));
          assert(parsed.fields.model === IMAGE_MODEL, "edit multipart model did not reach the images relay");
          assert(parsed.fields.prompt === "runtime edit sentinel", "edit multipart prompt did not reach the images relay");
          assert(parsed.fields.n === "1", "edit multipart must keep n=1");
          assert(parsed.files.filter((file) => file.name === "image[]").length === 2, "edit multipart did not contain two images");
          assert(parsed.files.some((file) => file.name === "mask" && file.filename === "mask.png"), "edit multipart did not contain mask.png");
          assert(parsed.files.some((file) => file.name === "image[]" && file.filename === "runtime-generate.png"), "edit multipart did not use the generated PNG");
          assert(parsed.files.some((file) => file.name === "image[]" && file.filename === "reference.png"), "edit multipart did not use reference.png");
          requests.push({ kind: "edit", fields: parsed.fields, files: parsed.files.map(({ name, filename, byteLength }) => ({ name, filename, byteLength })) });
        }
        jsonResponse(response, 200, { data: [{ b64_json: PNG_BASE64, revised_prompt: "runtime relay" }] });
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
        jsonResponse(response, 500, { error: { message: "fake images relay rejected the request", type: "runtime_smoke" } });
      }
    })();
  });

  return {
    server,
    async start() {
      const port = await listen(server);
      return `http://127.0.0.1:${port}`;
    },
    async close() {
      await closeServer(server);
    },
    requests,
    failures,
  };
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (child.exitCode === null && child.signalCode === null) child.kill();
  await Promise.race([
    once(child, "exit"),
    new Promise((resolveExit) => setTimeout(resolveExit, 2_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function startOpenCode(project, environment, signal) {
  const port = await reservePort();
  const child = spawn(binary, ["serve", "--print-logs", "--log-level", "DEBUG", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: project,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const collect = (chunk) => { output += chunk; };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  try {
    const baseURL = await new Promise((resolveURL, rejectURL) => {
      const timer = setTimeout(() => rejectURL(new Error(`OpenCode server startup timed out\n${output.slice(-4_000)}`)), 15_000);
      const abort = () => rejectURL(signal.reason instanceof Error ? signal.reason : new Error("runtime smoke total timeout exceeded"));
      const check = () => {
        const match = output.match(/https?:\/\/127\.0\.0\.1:\d+/iu);
        if (!match) return;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        resolveURL(match[0]);
      };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", check);
      child.stderr.on("data", check);
      child.once("error", (error) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        rejectURL(error);
      });
      child.once("exit", (code, exitSignal) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        rejectURL(new Error(`OpenCode exited before listening: code=${code} signal=${exitSignal}`));
      });
      check();
    });
    return { child, baseURL, getOutput: () => output };
  } catch (error) {
    await stopChild(child);
    throw error;
  }
}

async function requestJSON(url, init, signal) {
  const response = await fetch(url, { ...init, signal });
  const text = await response.text();
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${new URL(url).pathname} returned HTTP ${response.status}: ${safeLog(text.slice(0, 1_000), [AGENT_API_KEY, IMAGE_API_KEY, IMAGE_HEADER])}`);
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${init?.method ?? "GET"} ${new URL(url).pathname} returned invalid JSON`);
  }
}

function apiURL(baseURL, path, project) {
  const url = new URL(path, baseURL);
  url.searchParams.set("directory", project);
  return url;
}

async function fetchToolSchema(baseURL, project, signal) {
  const ids = await requestJSON(apiURL(baseURL, "/experimental/tool/ids", project), undefined, signal);
  assert(Array.isArray(ids), "tool ID registry was not an array");
  for (const required of ["openai_image_generate", "openai_image_edit"]) {
    assert(ids.includes(required), `tool ID registry missing ${required}`);
  }
  const toolSchemaURL = apiURL(baseURL, "/experimental/tool", project);
  toolSchemaURL.searchParams.set("provider", AGENT_PROVIDER);
  toolSchemaURL.searchParams.set("model", AGENT_MODEL);
  const tools = await requestJSON(toolSchemaURL, undefined, signal);
  assert(Array.isArray(tools), "experimental tool schema response was not an array");
  for (const required of ["openai_image_generate", "openai_image_edit"]) {
    const tool = tools.find((candidate) => candidate?.id === required);
    assert(tool && isRecord(tool.parameters), `experimental tool schema missing ${required}`);
    assert(tool.parameters.type === "object", `experimental tool schema for ${required} is not an object schema`);
  }
  return { ids, tools: tools.filter((tool) => ["openai_image_generate", "openai_image_edit"].includes(tool?.id)) };
}

async function createSession(baseURL, project, signal) {
  const session = await requestJSON(apiURL(baseURL, "/session", project), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "runtime proof",
      agent: "build",
      model: { id: AGENT_MODEL, providerID: AGENT_PROVIDER },
    }),
  }, signal);
  assert(session && typeof session.id === "string" && session.id.startsWith("ses"), "session API did not return a session ID");
  return session;
}

async function promptSession(baseURL, project, sessionID, signal) {
  const response = await fetch(apiURL(baseURL, `/session/${sessionID}/prompt_async`, project), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: { providerID: AGENT_PROVIDER, modelID: AGENT_MODEL },
      agent: "build",
      tools: { openai_image_generate: true, openai_image_edit: true },
      parts: [{ type: "text", text: "Run the runtime image proof." }],
    }),
    signal,
  });
  if (response.status !== 204 && response.status !== 200) throw new Error(`session prompt returned HTTP ${response.status}`);
}

function completedToolParts(messages) {
  return messages.flatMap((message) => Array.isArray(message?.parts) ? message.parts : [])
    .filter((part) => part?.type === "tool" && part?.state?.status === "completed");
}

async function waitForSession(baseURL, project, sessionID, agent, signal) {
  const deadline = Date.now() + SESSION_TIMEOUT_MS;
  let lastToolNames = [];
  while (Date.now() < deadline) {
    const messages = await requestJSON(apiURL(baseURL, `/session/${sessionID}/message`, project), undefined, signal);
    const toolParts = completedToolParts(Array.isArray(messages) ? messages : []);
    lastToolNames = toolParts.map((part) => part.tool);
    const hasGenerate = toolParts.some((part) => part.tool === "openai_image_generate");
    const hasEdit = toolParts.some((part) => part.tool === "openai_image_edit");
    const finalText = (Array.isArray(messages) ? messages : []).some((message) => message?.info?.role === "assistant" && message.parts?.some((part) => part?.type === "text" && part.text.includes("runtime generate and edit complete")));
    const failedAssistant = (Array.isArray(messages) ? messages : []).some((message) => message?.info?.role === "assistant" && message.info.error);
    if (failedAssistant) throw new Error("real OpenCode session produced an assistant error");
    if (hasGenerate && hasEdit && finalText && agent.calls.length >= 3 && agent.calls[1]?.hasToolResult && agent.calls[2]?.hasToolResult) {
      return { messages, toolParts };
    }
    await new Promise((resolveRetry) => setTimeout(resolveRetry, 100));
  }
  throw new Error(`session did not complete generate/edit loop; tool parts=${JSON.stringify(lastToolNames)} agent calls=${agent.calls.length}`);
}

async function assertPNG(path) {
  const bytes = await readFile(path);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert(bytes.subarray(0, signature.length).equals(signature), `${path} was not a PNG`);
  assert(bytes.byteLength > signature.length, `${path} was empty after the PNG signature`);
  return bytes.byteLength;
}

async function run() {
  assert(process.platform === "linux", "runtime smoke is pinned to Linux/Ubuntu: OpenCode 1.18.4 process and provider behavior are only verified there");
  const controller = new AbortController();
  const totalTimeout = setTimeout(() => controller.abort(new Error("runtime smoke total timeout exceeded")), TOTAL_TIMEOUT_MS);
  let temp;
  let agent;
  let images;
  let openCode;
  try {
    temp = await mkdtemp(join(tmpdir(), "opencode-openai-images-runtime-"));
    const project = join(temp, "project");
    const xdgConfig = join(temp, "xdg-config");
    const xdgData = join(temp, "xdg-data");
    const xdgCache = join(temp, "xdg-cache");
    const xdgState = join(temp, "xdg-state");
    const configDirectory = join(xdgConfig, "opencode");
    await Promise.all([project, xdgConfig, xdgData, xdgCache, xdgState, configDirectory].map((directory) => mkdir(directory, { recursive: true })));
    await writeFile(join(configDirectory, "config.json"), "{}");
    await writeFile(join(project, "reference.png"), PNG_BYTES);
    await writeFile(join(project, "mask.png"), PNG_BYTES);

    agent = makeAgentRelay();
    images = makeImagesRelay();
    const agentBaseURL = await agent.start();
    const imagesBaseURL = await images.start();
    const apiKeyFile = join(temp, "images-api-key.txt");
    const nestedHeaderFile = join(temp, "nested-header.txt");
    await writeFile(apiKeyFile, IMAGE_API_KEY);
    await writeFile(nestedHeaderFile, IMAGE_HEADER);

    await writeFile(join(project, "opencode.json"), JSON.stringify({
      "$schema": "https://opencode.ai/config.json",
      "model": `${AGENT_PROVIDER}/${AGENT_MODEL}`,
      "agent": {
        "build": {
          "model": `${AGENT_PROVIDER}/${AGENT_MODEL}`,
          "maxSteps": 5,
          "permission": { "*": "allow" },
        },
      },
      "permission": { "*": "allow" },
      "provider": {
        [AGENT_PROVIDER]: {
          "name": "Runtime fake agent",
          "npm": "@ai-sdk/openai-compatible",
          "options": { "baseURL": agentBaseURL, "apiKey": AGENT_API_KEY },
          "models": {
            [AGENT_MODEL]: {
              "name": "Runtime fake agent model",
              "tool_call": true,
              "limit": { "context": 100_000, "output": 4_096 },
              "cost": { "input": 0, "output": 0 },
              "modalities": { "input": ["text"], "output": ["text"] },
            },
          },
        },
      },
      "plugin": [[entry, {
        "connections": {
          runtime: {
            "baseURL": "{env:RUNTIME_IMAGES_BASE_URL}",
            "model": IMAGE_MODEL,
            "apiKey": `{file:${apiKeyFile}}`,
            "headers": {
              "X-Runtime-Nested-Header": `{file:${nestedHeaderFile}}`,
            },
          },
        },
        "defaultConnection": "runtime",
      }]],
    }, null, 2));

    const environment = {
      ...process.env,
      XDG_CONFIG_HOME: xdgConfig,
      XDG_DATA_HOME: xdgData,
      XDG_CACHE_HOME: xdgCache,
      XDG_STATE_HOME: xdgState,
      OPENCODE_TEST_HOME: temp,
      OPENCODE_CONFIG_DIR: configDirectory,
      OPENCODE_DISABLE_MODELS_FETCH: "true",
      OPENCODE_DISABLE_AUTOUPDATE: "true",
      OPENCODE_DISABLE_AUTOCOMPACT: "true",
      OPENCODE_DISABLE_PRUNE: "true",
      OPENCODE_CLIENT: "runtime-smoke",
      RUNTIME_IMAGES_BASE_URL: imagesBaseURL,
    };

    openCode = await startOpenCode(project, environment, controller.signal);
    const schema = await fetchToolSchema(openCode.baseURL, project, controller.signal);
    console.log(`RUNTIME_OPENCODE_SCHEMA_OK: ${schema.tools.map((tool) => tool.id).join(",")}`);
    const session = await createSession(openCode.baseURL, project, controller.signal);
    await promptSession(openCode.baseURL, project, session.id, controller.signal);
    const result = await waitForSession(openCode.baseURL, project, session.id, agent, controller.signal);
    assert(agent.failures.length === 0, `fake agent relay failures: ${agent.failures.join("; ")}`);
    assert(images.failures.length === 0, `fake images relay failures: ${images.failures.join("; ")}`);
    assert(images.requests.some((request) => request.kind === "generation"), "fake images relay did not capture generation JSON");
    assert(images.requests.some((request) => request.kind === "edit"), "fake images relay did not capture edit multipart");
    const generatedBytes = await assertPNG(join(project, "generated", "runtime-generate.png"));
    const editedBytes = await assertPNG(join(project, "edited", "runtime-edit.png"));
    assert(result.toolParts.every((part) => part.state.status === "completed"), "session had a non-completed image tool part");
    console.log(`RUNTIME_AGENT_PROTOCOL_OK: ${agent.calls.map((call) => `${call.path} stream=${call.stream} toolResult=${call.hasToolResult}`).join(" | ")} required-tools=generate+edit`);
    console.log(`RUNTIME_IMAGES_OK: ${images.requests.map((request) => request.kind).join("+")} requests=${images.requests.length}`);
    console.log(`RUNTIME_OPENCODE_OK: session=${session.id} tool-parts=${result.toolParts.length} png-bytes=${generatedBytes},${editedBytes}`);
  } finally {
    clearTimeout(totalTimeout);
    if (openCode) await stopChild(openCode.child);
    if (agent) await agent.close();
    if (images) await images.close();
    if (temp) await rm(temp, { recursive: true, force: true });
  }
}

try {
  await run();
} catch (error) {
  console.error(`RUNTIME_OPENCODE_FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
