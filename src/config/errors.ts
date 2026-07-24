export class ConfigError extends Error {
  readonly code = "CONFIG_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export class ConnectionSelectionError extends Error {
  readonly code = "CONNECTION_SELECTION_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "ConnectionSelectionError";
  }
}
