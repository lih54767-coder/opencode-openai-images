import { describe, expect, test } from "bun:test";
import { ConnectionCatalog } from "../src/connections/index.js";
import { ConfigError, normalizeBaseURL, parsePluginConfig } from "../src/config/index.js";

const oneConnection = {
  connections: {
    primary: {
      baseURL: "https://relay.example.test/api/v1///",
      model: "configured-image-model",
    },
  },
};

describe("configuration parsing", () => {
  test("auto-selects the only connection, resolves defaults, and preserves the API path prefix", () => {
    const config = parsePluginConfig(oneConnection);

    expect(config.defaultConnection).toBe("primary");
    expect(config.outputDir).toBe("outputs");
    expect(config.connections.primary?.baseURL).toBe("https://relay.example.test/api/v1");
    expect(config.connections.primary?.model).toBe("configured-image-model");
    expect(config.connections.primary?.timeoutMs).toBe(600_000);
    expect(config.connections.primary?.headers).toEqual({});
    expect(config.connections.primary?.capabilities).toEqual({ edit: true, mask: true });
    expect(config.connections.primary?.defaults).toEqual({ generate: {}, edit: {} });
  });

  test("requires an existing explicit default for multiple connections", () => {
    expect(() => parsePluginConfig({
      connections: {
        first: { baseURL: "https://one.example.test", model: "model-a" },
        second: { baseURL: "https://two.example.test", model: "model-b" },
      },
    })).toThrow("defaultConnection is required");

    expect(() => parsePluginConfig({
      connections: {
        first: { baseURL: "https://one.example.test", model: "model-a" },
        second: { baseURL: "https://two.example.test", model: "model-b" },
      },
      defaultConnection: "missing",
    })).toThrow("does not exist");

    const config = parsePluginConfig({
      connections: {
        first: { baseURL: "https://one.example.test", model: "model-a" },
        second: { baseURL: "https://two.example.test", model: "model-b" },
      },
      defaultConnection: "second",
    });
    expect(config.defaultConnection).toBe("second");
  });

  test("rejects empty maps and unknown fields", () => {
    expect(() => parsePluginConfig({ connections: {} })).toThrow("non-empty map");
    expect(() => parsePluginConfig({ ...oneConnection, unsupported: true })).toThrow("unknown fields are rejected");
    expect(() => parsePluginConfig({
      connections: {
        primary: { baseURL: "https://relay.example.test", model: "model", unsupported: true },
      },
    })).toThrow("connections.primary.unsupported");
    expect(() => parsePluginConfig({
      connections: {
        primary: {
          baseURL: "https://relay.example.test",
          model: "model",
          defaults: { generate: { unsupported: true } },
        },
      },
    })).toThrow("defaults.generate.unsupported");
  });

  test("validates URL shape and only removes trailing slashes", () => {
    expect(normalizeBaseURL("https://relay.example.test/prefix///")).toBe("https://relay.example.test/prefix");
    expect(normalizeBaseURL("http://relay.example.test")).toBe("http://relay.example.test");
    expect(() => normalizeBaseURL("ftp://relay.example.test")).toThrow(ConfigError);
    expect(() => normalizeBaseURL("https://relay.example.test/api?query=1")).toThrow("API root");
    expect(() => normalizeBaseURL("https://relay.example.test/api#fragment")).toThrow("API root");
  });

  test("validates timeout, output directory, and connection names", () => {
    const config = parsePluginConfig({
      ...oneConnection,
      outputDir: "assets/generated",
      connections: {
        primary: {
          baseURL: "https://relay.example.test",
          model: "model",
          timeoutMs: 600_001,
        },
      },
    });
    expect(config.outputDir).toBe("assets/generated");
    expect(config.connections.primary?.timeoutMs).toBe(600_001);

    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
      expect(() => parsePluginConfig({
        ...oneConnection,
        connections: { primary: { ...oneConnection.connections.primary, timeoutMs } },
      })).toThrow("timeoutMs");
    }
    expect(() => parsePluginConfig({ ...oneConnection, outputDir: "/tmp/images" })).toThrow("relative path");
    expect(() => parsePluginConfig({ ...oneConnection, outputDir: "../images" })).toThrow("'..'");

    for (const name of [" primary", "primary ", "primary\n", "primary\0", "x".repeat(65)]) {
      expect(() => parsePluginConfig({
        connections: { [name]: { baseURL: "https://relay.example.test", model: "model" } },
      })).toThrow("connections");
    }
  });

  test("parses split generate/edit defaults and rejects incompatible fields", () => {
    const config = parsePluginConfig({
      connections: {
        primary: {
          baseURL: "https://relay.example.test",
          model: "model",
          defaults: {
            generate: { size: "2048x2048", quality: "cinematic", outputFormat: "jpeg", outputCompression: 80 },
            edit: { inputFidelity: "high", outputFormat: "png" },
          },
        },
      },
    });
    expect(config.connections.primary?.defaults.generate).toEqual({
      size: "2048x2048",
      quality: "cinematic",
      outputFormat: "jpeg",
      outputCompression: 80,
    });
    expect(config.connections.primary?.defaults.edit).toEqual({ inputFidelity: "high", outputFormat: "png" });

    expect(() => parsePluginConfig({
      connections: {
        primary: {
          baseURL: "https://relay.example.test",
          model: "model",
          defaults: { generate: { inputFidelity: "high" } },
        },
      },
    })).toThrow("only valid for edit defaults");

    for (const operation of ["generate", "edit"] as const) {
      expect(() => parsePluginConfig({
        connections: {
          primary: {
            baseURL: "https://relay.example.test",
            model: "model",
            defaults: { [operation]: { outputFormat: "png", outputCompression: 50 } },
          },
        },
      })).toThrow("outputCompression");
    }
    expect(() => parsePluginConfig({
      connections: {
        primary: {
          baseURL: "https://relay.example.test",
          model: "model",
          defaults: { generate: { outputCompression: 50 } },
        },
      },
    })).toThrow("outputFormat jpeg or webp");
  });

  test("enforces header token, secret control-character, auth, and hop-by-hop rules", () => {
    const config = parsePluginConfig({
      connections: {
        primary: {
          baseURL: "https://relay.example.test",
          model: "model",
          headers: { Authorization: "Bearer explicit", "X-Custom_Header": "ok" },
        },
      },
    });
    expect(config.connections.primary?.headers.Authorization).toBe("Bearer explicit");

    for (const header of ["Host", "content-length", "Content-Type", "TRANSFER-ENCODING", "Connection", "Keep-Alive", "Upgrade"]) {
      expect(() => parsePluginConfig({
        connections: {
          primary: { baseURL: "https://relay.example.test", model: "model", headers: { [header]: "blocked" } },
        },
      })).toThrow("forbidden");
    }
    expect(() => parsePluginConfig({
      connections: {
        primary: { baseURL: "https://relay.example.test", model: "model", headers: { "bad name": "value" } },
      },
    })).toThrow("HTTP token");
    expect(() => parsePluginConfig({
      connections: {
        primary: { baseURL: "https://relay.example.test", model: "model", headers: { "X-Test": "bad\u0001value" } },
      },
    })).toThrow("control characters");
    expect(() => parsePluginConfig({
      connections: {
        primary: { baseURL: "https://relay.example.test", model: "model", apiKey: "bad\u0000key" },
      },
    })).toThrow("apiKey");
    expect(() => parsePluginConfig({
      connections: {
        primary: {
          baseURL: "https://relay.example.test",
          model: "model",
          apiKey: "secret",
          headers: { Authorization: "Bearer another" },
        },
      },
    })).toThrow("apiKey");
  });

  test("rejects contradictory capabilities", () => {
    expect(() => parsePluginConfig({
      connections: {
        primary: {
          baseURL: "https://relay.example.test",
          model: "model",
          capabilities: { edit: false, mask: true },
        },
      },
    })).toThrow("edit=false while mask=true");

    const editDisabled = parsePluginConfig({
      connections: {
        primary: {
          baseURL: "https://relay.example.test",
          model: "model",
          capabilities: { edit: false },
        },
      },
    });
    expect(editDisabled.connections.primary?.capabilities).toEqual({ edit: false, mask: false });
  });

  test("bounds connection descriptions and model strings without rejecting Unicode model names", () => {
    const config = parsePluginConfig({
      connections: {
        primary: {
          baseURL: "https://relay.example.test",
          model: "模型/._-v1",
          description: "描述含有 Unicode",
        },
      },
    });
    expect(config.connections.primary?.description).toBe("描述含有 Unicode");
    expect(config.connections.primary?.model).toBe("模型/._-v1");

    expect(() => parsePluginConfig({
      connections: {
        primary: { baseURL: "https://relay.example.test", model: "model", description: "x".repeat(257) },
      },
    })).toThrow("description");
    expect(() => parsePluginConfig({
      connections: {
        primary: { baseURL: "https://relay.example.test", model: "bad\u0001model" },
      },
    })).toThrow("model");
  });
});

describe("connection selection", () => {
  test("selects the configured default or an explicit configured name", () => {
    const config = parsePluginConfig({
      connections: {
        first: { baseURL: "https://one.example.test", model: "model-a" },
        second: { baseURL: "https://two.example.test", model: "model-b" },
      },
      defaultConnection: "first",
    });
    const catalog = new ConnectionCatalog(config);

    expect(catalog.get().name).toBe("first");
    expect(catalog.get("second").model).toBe("model-b");
    expect(catalog.target("second")).toMatchObject({ name: "second", model: "model-b", headers: {}, timeoutMs: 600_000 });
    expect(() => catalog.get("unknown")).toThrow("not configured");
    expect(catalog.names()).toEqual(["first", "second"]);
  });
});
