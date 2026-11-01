import type { Readable, Writable } from "node:stream";

/** A JSON-RPC 2.0 request or notification received from the TypeScript host. */
export interface IncomingMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
}

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export const ErrorCodes = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

export type RequestHandler = (method: string, params: unknown) => Promise<unknown>;

const HEADER_END = Buffer.from("\r\n\r\n");

/**
 * Serves JSON-RPC 2.0 with LSP base-protocol framing (`Content-Length` headers), which is what the
 * TypeScript content mapper host speaks over the mapper process's stdin/stdout. Requests are
 * handled concurrently and answered in completion order.
 */
export function serve(input: Readable, output: Writable, handle: RequestHandler): Promise<void> {
  let buffer: Buffer = Buffer.alloc(0);

  const send = (message: object) => {
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }), "utf8");
    output.write(`Content-Length: ${body.length}\r\n\r\n`);
    output.write(body);
  };

  const dispatch = (message: IncomingMessage) => {
    const isRequest = message.id !== undefined && message.id !== null;
    if (typeof message.method !== "string") {
      if (isRequest) send({ id: message.id, error: { code: ErrorCodes.InvalidRequest, message: "Missing method." } });
      return;
    }
    handle(message.method, message.params).then(
      (result) => {
        if (isRequest) send({ id: message.id, result: result ?? null });
      },
      (error: unknown) => {
        if (!isRequest) return;
        const code = error instanceof RpcError ? error.code : ErrorCodes.InternalError;
        const text = error instanceof Error ? error.message : String(error);
        send({ id: message.id, error: { code, message: text } });
      },
    );
  };

  const drain = () => {
    for (;;) {
      const headerEnd = buffer.indexOf(HEADER_END);
      if (headerEnd === -1) return;
      const header = buffer.subarray(0, headerEnd).toString("ascii");
      const match = /^content-length:\s*(\d+)\s*$/im.exec(header);
      if (!match) {
        // Unrecoverable framing error: drop the header and keep going.
        buffer = buffer.subarray(headerEnd + HEADER_END.length);
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + HEADER_END.length;
      if (buffer.length < bodyStart + length) return;
      const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      buffer = buffer.subarray(bodyStart + length);
      let message: IncomingMessage;
      try {
        message = JSON.parse(body) as IncomingMessage;
      } catch {
        send({ id: null, error: { code: ErrorCodes.ParseError, message: "Invalid JSON." } });
        continue;
      }
      dispatch(message);
    }
  };

  return new Promise((resolve) => {
    input.on("data", (chunk: Buffer) => {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      drain();
    });
    input.on("end", () => resolve());
    input.on("close", () => resolve());
  });
}
