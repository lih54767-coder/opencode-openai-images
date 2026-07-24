import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const entry = resolve(process.cwd(), "dist/index.js");
if (!existsSync(entry)) throw new Error("smoke:plugin requires a built dist/index.js");

const moduleNamespace = await import(pathToFileURL(entry).href);
if (Object.keys(moduleNamespace).join(",") !== "default") {
  throw new Error("smoke:plugin expected the compiled root module to expose only default");
}
const plugin = moduleNamespace.default;
if (plugin?.id !== "opencode-openai-images" || typeof plugin?.server !== "function") {
  throw new Error("smoke:plugin expected a callable OpenCode PluginModule default");
}
const hooks = await plugin.server({}, {
  connections: {
    smoke: {
      baseURL: "https://relay.example.test",
      model: "smoke-model",
    },
  },
});
const toolNames = Object.keys(hooks.tool ?? {});
if (toolNames.join(",") !== "openai_image_generate,openai_image_edit") {
  throw new Error(`smoke:plugin unexpected tools: ${toolNames.join(",")}`);
}
console.log("SMOKE_PLUGIN_OK: compiled PluginModule accepted and both tools registered");
