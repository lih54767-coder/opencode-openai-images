import { ConnectionSelectionError } from "../config/errors.js";
import type { ResolvedConnection, ResolvedPluginConfig, ResolvedTransportTarget } from "../config/types.js";

export class ConnectionCatalog {
  constructor(private readonly config: ResolvedPluginConfig) {}

  get(name?: string): ResolvedConnection {
    const selectedName = name ?? this.config.defaultConnection;
    const connection = this.config.connections[selectedName];
    if (!connection) {
      throw new ConnectionSelectionError(`connection '${selectedName}' is not configured`);
    }
    return connection;
  }

  target(name?: string): ResolvedTransportTarget {
    const connection = this.get(name);
    const target: ResolvedTransportTarget = {
      name: connection.name,
      baseURL: connection.baseURL,
      model: connection.model,
      headers: connection.headers,
      timeoutMs: connection.timeoutMs,
    };
    if (connection.apiKey !== undefined) target.apiKey = connection.apiKey;
    return target;
  }

  names(): readonly string[] {
    return Object.keys(this.config.connections);
  }
}
