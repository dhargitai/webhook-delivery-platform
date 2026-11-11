import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';

/** PRD: the stored response snippet is at most 1 KB. */
const DEFAULT_SNIPPET_BYTES = 1_024;
/** PRD: a response is read up to about 64 KB. */
const DEFAULT_MAX_RESPONSE_BYTES = 65_536;
/** PRD: 3 s to connect, 10 s for the whole call. */
const DEFAULT_CONNECT_TIMEOUT_MS = 3_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 10_000;

export interface SafeHttpClientOptions {
  /** How many bytes of the response body to keep as a snippet. */
  snippetBytes?: number;
  /** A response body longer than this fails the attempt. */
  maxResponseBytes?: number;
  /** DNS, TCP and TLS together must finish within this. */
  connectTimeoutMs?: number;
  /** The whole call, from the start to the last byte of the response. */
  totalTimeoutMs?: number;
  /**
   * Resolves the host when connecting. This is where the SSRF guard plugs in:
   * it resolves, checks the address against the deny-list and returns it, so
   * the connection goes to the very address that was checked.
   */
  lookup?: LookupFunction;
  /**
   * Checked before connecting, with the URL's host. Returns why the host must
   * be refused, or `undefined`. It exists because Node skips `lookup` for a
   * host that is already an IP address (`http://169.254.169.254/`), so the
   * guard has to look at those here. IPv6 hosts come without their brackets.
   */
  hostCheck?: (hostname: string) => string | undefined;
  /**
   * An extra root certificate to trust for https, on top of the system's. It
   * adds trust and nothing else: the certificate chain and the host name are
   * still verified. For a private CA, and for tests with a self-signed one.
   */
  ca?: string | Buffer;
}

export type HttpFailureKind =
  | 'http_error'
  | 'redirect'
  | 'response_too_large'
  | 'connect_timeout'
  | 'timeout'
  | 'network_error'
  | 'ssrf_blocked'
  | 'invalid_url';

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
  private readonly connectTimeoutMs: number;
  private readonly totalTimeoutMs: number;
  private readonly lookup: LookupFunction | undefined;
  private readonly hostCheck:
    ((hostname: string) => string | undefined) | undefined;
  private readonly ca: string | Buffer | undefined;

  constructor({
    snippetBytes = DEFAULT_SNIPPET_BYTES,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    totalTimeoutMs = DEFAULT_TOTAL_TIMEOUT_MS,
    lookup,
    hostCheck,
    ca,
  }: SafeHttpClientOptions = {}) {
    requirePositiveInteger('snippetBytes', snippetBytes);
    requirePositiveInteger('maxResponseBytes', maxResponseBytes);
    requirePositiveInteger('connectTimeoutMs', connectTimeoutMs);
    requirePositiveInteger('totalTimeoutMs', totalTimeoutMs);
    if (connectTimeoutMs > totalTimeoutMs) {
      // It could never fire: the total limit would always cut the call first.
      throw new RangeError(
        `connectTimeoutMs (${connectTimeoutMs}) must not exceed totalTimeoutMs (${totalTimeoutMs})`,
      );
    }
    this.snippetBytes = snippetBytes;
    this.maxResponseBytes = maxResponseBytes;
    this.connectTimeoutMs = connectTimeoutMs;
    this.totalTimeoutMs = totalTimeoutMs;
    this.lookup = lookup;
    this.hostCheck = hostCheck;
    this.ca = ca;
  }

  post(
    url: string,
    headers: Record<string, string>,
    body: string | Uint8Array,
  ): Promise<HttpResult> {
    const startedAt = performance.now();
    const latency = () => Math.round(performance.now() - startedAt);
    const payload = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
    // Registration already refuses such URLs; a bad stored value must still be
    // a failed attempt, not an exception out of the worker's consumer.
    const target = URL.parse(url);
    if (target?.protocol !== 'http:' && target?.protocol !== 'https:') {
      return Promise.resolve({
        outcome: 'failed',
        kind: 'invalid_url',
        latencyMs: latency(),
        error: 'the URL must be an absolute http or https URL',
      });
    }
    // The URL parser keeps the brackets of an IPv6 host; an address has none.
    const blocked = this.hostCheck?.(target.hostname.replace(/^\[|\]$/g, ''));
    if (blocked !== undefined) {
      return Promise.resolve({
        outcome: 'failed',
        kind: 'ssrf_blocked',
        latencyMs: latency(),
        error: blocked,
      });
    }
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;

    return new Promise<HttpResult>((resolvePromise) => {
      let connectTimer: NodeJS.Timeout | undefined;
      let totalTimer: NodeJS.Timeout | undefined;
      // A promise settles once, so the error that destroying the request raises
      // after a timeout or an oversized body cannot replace the result already
      // resolved. Every outcome also stops both timers, so none outlives the call.
      const resolve = (result: HttpResult) => {
        clearTimeout(connectTimer);
        clearTimeout(totalTimer);
        resolvePromise(result);
      };
      const req = send(
        target,
        {
          method: 'POST',
          headers: { ...headers, 'content-length': payload.byteLength },
          // A fresh connection per call: a pooled socket would skip whatever
          // is decided when connecting (the SSRF guard pins the IP there).
          agent: false,
          lookup: this.lookup,
          // Only https looks at it; http ignores the option.
          ca: this.ca,
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

      const timeout = (kind: 'connect_timeout' | 'timeout', error: string) => {
        resolve({ outcome: 'failed', kind, latencyMs: latency(), error });
        req.destroy();
      };
      totalTimer = setTimeout(
        () =>
          timeout(
            'timeout',
            `no complete response within ${this.totalTimeoutMs} ms`,
          ),
        this.totalTimeoutMs,
      );
      // Node's own `timeout` option only watches for idleness, so the connect
      // phase (DNS, TCP, and TLS for https) gets its own timer, stopped once
      // the connection is up.
      connectTimer = setTimeout(
        () =>
          timeout(
            'connect_timeout',
            `not connected within ${this.connectTimeoutMs} ms`,
          ),
        this.connectTimeoutMs,
      );
      req.on('socket', (socket) => {
        socket.once(
          target.protocol === 'https:' ? 'secureConnect' : 'connect',
          () => clearTimeout(connectTimer),
        );
      });
      req.end(payload);
    });
  }
}

function networkError(error: Error, latencyMs: number): HttpResult {
  // A connection error often has an empty message; its code says what happened.
  const code = (error as NodeJS.ErrnoException).code;
  // The guard's refusal, raised from `lookup`: not a network fault.
  if (code === 'ESSRF') {
    return {
      outcome: 'failed',
      kind: 'ssrf_blocked',
      latencyMs,
      error: error.message,
    };
  }
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
