export type ImagesTransportErrorCode =
  | "ABORTED"
  | "TIMEOUT"
  | "NETWORK_ERROR"
  | "HTTP_ERROR"
  | "INVALID_INPUT"
  | "INVALID_RESPONSE";

export interface ImagesTransportErrorDetails {
  code: ImagesTransportErrorCode;
  message: string;
  status?: number;
  providerCode?: string;
  providerType?: string;
  requestId?: string;
}

export class ImagesTransportError extends Error {
  readonly code: ImagesTransportErrorCode;
  readonly status?: number;
  readonly providerCode?: string;
  readonly providerType?: string;
  readonly requestId?: string;

  constructor(details: ImagesTransportErrorDetails) {
    super(details.message);
    this.name = "ImagesTransportError";
    this.code = details.code;
    if (details.status !== undefined) this.status = details.status;
    if (details.providerCode !== undefined) this.providerCode = details.providerCode;
    if (details.providerType !== undefined) this.providerType = details.providerType;
    if (details.requestId !== undefined) this.requestId = details.requestId;
  }
}

export class ImagesTransportAbortError extends ImagesTransportError {
  constructor() {
    super({ code: "ABORTED", message: "OpenAI Images request was cancelled by the caller." });
    this.name = "ImagesTransportAbortError";
  }
}

export class ImagesTransportTimeoutError extends ImagesTransportError {
  constructor(timeoutMs: number) {
    super({ code: "TIMEOUT", message: `OpenAI Images request timed out after ${timeoutMs}ms.` });
    this.name = "ImagesTransportTimeoutError";
  }
}

export class ImagesTransportNetworkError extends ImagesTransportError {
  constructor() {
    super({ code: "NETWORK_ERROR", message: "OpenAI Images request failed before receiving a response." });
    this.name = "ImagesTransportNetworkError";
  }
}

export class ImagesTransportInputError extends ImagesTransportError {
  constructor(message: string) {
    super({ code: "INVALID_INPUT", message });
    this.name = "ImagesTransportInputError";
  }
}

export class ImagesTransportResponseError extends ImagesTransportError {
  constructor(message: string, status?: number) {
    const details: ImagesTransportErrorDetails = { code: "INVALID_RESPONSE", message };
    if (status !== undefined) details.status = status;
    super(details);
    this.name = "ImagesTransportResponseError";
  }
}

export class ImagesTransportHttpError extends ImagesTransportError {
  constructor(details: Omit<ImagesTransportErrorDetails, "code"> & { status: number }) {
    super({ ...details, code: "HTTP_ERROR" });
    this.name = "ImagesTransportHttpError";
  }
}
