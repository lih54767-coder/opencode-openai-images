import type { Plugin, PluginModule, PluginOptions } from "@opencode-ai/plugin";
import { parsePluginConfig } from "./config/parse.js";
import { createOpenAIImagesTransport } from "./protocol/openai-images/transport.js";
import { createImageTools } from "./tools/image-tools.js";

const server: Plugin = async (_input, options: PluginOptions = {}) => {
  const config = parsePluginConfig(options);
  const tools = createImageTools(config, { transport: createOpenAIImagesTransport() });

  return {
    tool: {
      openai_image_generate: tools.generate,
      openai_image_edit: tools.edit,
    },
  };
};

const plugin: PluginModule = {
  id: "opencode-openai-images",
  server,
};

export default plugin;
