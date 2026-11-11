import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

/** PRD: the stored response snippet is at most 1 KB. */
const DEFAULT_SNIPPET_BYTES = 1_024;
/** PRD: a response is read up to about 64 KB. */
const DEFAULT_MAX_RESPONSE_BYTES = 65_536;

export interface SafeHttpClientOptions {
  /** How many bytes of the response body to keep as a snippet. */
  snippetBytes?: number;
  /** A response body longer than this fails the attempt. */
  maxResponseBytes?: number;
}

export type HttpFailureKind =
  'http_error' | 'redirect' | 'response_too_large' | 'network_error';

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
  private readonly maxResponseBytes: number;

  constructor({
    snippetBytes = DEFAULT_SNIPPET_BYTES,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  }: SafeHttpClientOptions = {}) {
    requirePositiveInteger('snippetBytes', snippetBytes);
    requirePositiveInteger('maxResponseBytes', maxResponseBytes);
    this.snippetBytes = snippetBytes;
    this.maxResponseBytes = maxResponseBytes;
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

    // A promise settles once, so the error that destroying the request raises
    // after an oversized body cannot replace the result already resolved.
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
          const status = res.statusCode ?? 0;
          // Never keep more than the cap, even if the snippet is set higher.
          const keepLimit = Math.min(this.snippetBytes, this.maxResponseBytes);
          const chunks: Buffer[] = [];
          let kept = 0;
          let received = 0;
          const snippet = () => Buffer.concat(chunks).toString('utf8');
          res.on('data', (chunk: Buffer) => {
            received += chunk.length;
            const part = chunk.subarray(0, keepLimit - kept);
            chunks.push(part);
            kept += part.length;
            // Counted here, not taken from content-length: a chunked body
            // declares none, and a header can lie.
            if (received > this.maxResponseBytes) {
              resolve({
                outcome: 'failed',
                kind: 'response_too_large',
                status,
                latencyMs: latency(),
                snippet: snippet(),
              });
              // Stop reading: a receiver must not be able to stream forever.
              req.destroy();
            }
          });
          res.on('end', () => {
            if (status >= 200 && status < 300) {
              resolve({
                outcome: 'success',
                status,
                latencyMs: latency(),
                snippet: snippet(),
              });
              return;
            }
            // Node's http never follows a redirect, and neither do we: the
            // Location header is receiver-controlled, so following it would
            // let a public URL send the request to an internal host.
            const kind =
              status >= 300 && status < 400 ? 'redirect' : 'http_error';
            resolve({
              outcome: 'failed',
              kind,
              status,
              latencyMs: latency(),
              snippet: snippet(),
            });
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

function requirePositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer, got ${value}`);
  }
}
