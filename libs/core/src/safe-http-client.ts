import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

/** PRD: the stored response snippet is at most 1 KB. */
const DEFAULT_SNIPPET_BYTES = 1_024;

export interface SafeHttpClientOptions {
  /** How many bytes of the response body to keep as a snippet. */
  snippetBytes?: number;
}

export type HttpFailureKind = 'http_error' | 'network_error';

export type HttpResult =
  | { outcome: 'success'; status: number; latencyMs: number; snippet: string }
  | {
      outcome: 'failed';
      kind: HttpFailureKind;
      status?: number;
      latencyMs: number;
      snippet?: string;
      error?: string;
    };

/**
 * Sends one webhook POST and classifies what came back. It never throws on
 * network or receiver trouble: every outcome is a result, because the caller
 * logs it as an attempt and decides about the retry. Only a 2xx is a success.
 */
export class SafeHttpClient {
  private readonly snippetBytes: number;

  constructor({
    snippetBytes = DEFAULT_SNIPPET_BYTES,
  }: SafeHttpClientOptions = {}) {
    this.snippetBytes = snippetBytes;
  }

  post(
    url: string,
    headers: Record<string, string>,
    body: string | Uint8Array,
  ): Promise<HttpResult> {
    const startedAt = performance.now();
    const latency = () => Math.round(performance.now() - startedAt);
    const payload = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
    const target = new URL(url);
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;

    return new Promise<HttpResult>((resolve) => {
      const req = send(
        target,
        {
          method: 'POST',
          headers: { ...headers, 'content-length': payload.byteLength },
          // A fresh connection per call: a pooled socket would skip whatever
          // is decided when connecting (the SSRF guard pins the IP there).
          agent: false,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let kept = 0;
          res.on('data', (chunk: Buffer) => {
            // Keep reading to the end, but store only what the snippet needs.
            const part = chunk.subarray(0, this.snippetBytes - kept);
            chunks.push(part);
            kept += part.length;
          });
          res.on('end', () => {
            const status = res.statusCode ?? 0;
            const snippet = Buffer.concat(chunks).toString('utf8');
            resolve(
              status >= 200 && status < 300
                ? { outcome: 'success', status, latencyMs: latency(), snippet }
                : {
                    outcome: 'failed',
                    kind: 'http_error',
                    status,
                    latencyMs: latency(),
                    snippet,
                  },
            );
          });
          res.on('error', (error) => resolve(networkError(error, latency())));
        },
      );
      req.on('error', (error) => resolve(networkError(error, latency())));
      req.end(payload);
    });
  }
}

function networkError(error: Error, latencyMs: number): HttpResult {
  // A connection error often has an empty message; its code says what happened.
  const code = (error as NodeJS.ErrnoException).code;
  return {
    outcome: 'failed',
    kind: 'network_error',
    latencyMs,
    error: [code, error.message].filter(Boolean).join(': ') || error.name,
  };
}
