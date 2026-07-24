import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const binary = process.env.OPENCODE_BIN ?? "opencode";
const root = process.cwd();
const entry = resolve(root, "dist/index.js");
const temp = await mkdtemp(join(tmpdir(), "opencode-openai-images-smoke-"));
const project = join(temp, "project");
const configHome = join(temp, "config");
const dataHome = join(temp, "data");
const cacheHome = join(temp, "cache");
const stateHome = join(temp, "state");
await Promise.all([project, configHome, dataHome, cacheHome, stateHome].map((directory) => mkdir(directory, { recursive: true })));

const compiledModule = await import(pathToFileURL(entry).href);
const compiledPlugin = compiledModule.default;
let invalidOptionsObserved = false;
try {
  await compiledPlugin.server({}, {});
} catch (error) {
  if (!/connections/iu.test(error instanceof Error ? error.message : String(error))) throw error;
  invalidOptionsObserved = true;
}
if (!invalidOptionsObserved) throw new Error("invalid plugin options did not execute the server/config parser");

const env = {
  ...process.env,
  XDG_CONFIG_HOME: configHome,
  XDG_DATA_HOME: dataHome,
  XDG_CACHE_HOME: cacheHome,
  XDG_STATE_HOME: stateHome,
};

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  await Promise.race([
    once(child, "exit"),
    new Promise((resolveResult) => setTimeout(resolveResult, 2_000)),
  ]);
}

async function startServer() {
  await writeFile(join(project, "opencode.json"), JSON.stringify({
    plugin: [[entry, {
      connections: { smoke: { baseURL: "https://relay.example.test", model: "smoke-model" } },
    }]],
  }, null, 2));

  const child = spawn(binary, ["serve", "--print-logs", "--log-level", "DEBUG", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: project,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let settled = false;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const collect = (chunk) => { output += chunk; };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);

  try {
    const baseURL = await new Promise((resolveURL, rejectURL) => {
      const timer = setTimeout(() => rejectURL(new Error(`OpenCode server startup timed out\n${output.slice(-4_000)}`)), 10_000);
      const check = () => {
        if (settled) return;
        const match = output.match(/https?:\/\/127\.0\.0\.1:\d+/iu);
        if (match) {
          settled = true;
          clearTimeout(timer);
          resolveURL(match[0]);
        }
      };
      child.stdout.on("data", check);
      child.stderr.on("data", check);
      child.once("error", (error) => {
        clearTimeout(timer);
        rejectURL(error);
      });
      child.once("exit", (code, signal) => {
        if (settled) return;
        clearTimeout(timer);
        rejectURL(new Error(`OpenCode exited before listening: code=${code} signal=${signal}\n${output.slice(-4_000)}`));
      });
    });
    return { child, baseURL, getOutput: () => output };
  } catch (error) {
    await stopChild(child);
    throw error;
  }
}

async function fetchToolIds(baseURL) {
  const endpoint = new URL("/experimental/tool/ids", baseURL);
  endpoint.searchParams.set("directory", project);
  const deadline = Date.now() + 10_000;
  let lastStatus = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(endpoint);
      if (response.status === 200) {
        let value;
        try {
          value = await response.json();
        } catch {
          throw new Error("tool registry returned invalid JSON");
        }
        if (!Array.isArray(value) || value.some((toolId) => typeof toolId !== "string")) {
          throw new Error("tool registry response was not a JSON string[]");
        }
        const required = ["openai_image_generate", "openai_image_edit"];
        const missing = required.filter((toolId) => !value.includes(toolId));
        if (missing.length > 0) throw new Error(`tool registry missing ${missing.join(", ")}`);
        return { endpoint: endpoint.toString(), toolIds: value };
      }
      lastStatus = `HTTP ${response.status}`;
    } catch (error) {
      if (error instanceof Error && /tool registry/iu.test(error.message)) throw error;
      lastStatus = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveRetry) => setTimeout(resolveRetry, 100));
  }
  throw new Error(`tool registry was not ready within 10s (${lastStatus})`);
}

try {
  const server = await startServer();
  try {
    const registry = await fetchToolIds(server.baseURL);
    console.log(`SMOKE_OPENCODE_OK: ${registry.endpoint} -> ${JSON.stringify(registry.toolIds)}`);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${server.getOutput().slice(-4_000)}`);
  } finally {
    await stopChild(server.child);
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}
