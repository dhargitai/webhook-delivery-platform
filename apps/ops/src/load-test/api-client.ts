import http from 'node:http';
import https from 'node:https';
import { describeError } from '../cli.js';

export type SendResult =
  | { kind: 'accepted'; eventId: string }
  | { kind: 'rate_limited' }
  | { kind: 'failed'; reason: string };

interface ApiResponse {
  status: number;
  body: string;
}

/**
 * Sockets kept open to the API. Well above what one API answers at once at
 * the planned load; past it, requests wait in the agent's queue.
 */
const MAX_SOCKETS = 256;

/**
 * The few public API calls a load test makes, as the tenant's own code would
 * make them: over HTTP with the tenant's API key.
 *
 * Built on `node:http` with a keep-alive agent rather than `fetch`: at about
 * a thousand requests a second, `fetch`'s per-request cost saturated the
 * generator's one thread, and the run measured the generator instead of the
 * platform.
 */
export class LoadApiClient {
  private readonly base: URL;
  private readonly transport: typeof http | typeof https;
  private readonly agent: http.Agent;

  constructor(baseUrl: string) {
    this.base = new URL(baseUrl);
    const secure = this.base.protocol === 'https:';
    this.transport = secure ? https : http;
    const options = { keepAlive: true, maxSockets: MAX_SOCKETS };
    this.agent = secure ? new https.Agent(options) : new http.Agent(options);
  }

  /** Registers an endpoint and returns its id. */
  async createEndpoint(apiKey: string, url: string): Promise<string> {
    const response = await this.call('POST', '/v1/endpoints', apiKey, { url });
    expectStatus(response, 201, `registering ${url}`);
    const body = parseJson(response.body);
    if (!isObject(body) || typeof body['id'] !== 'string') {
      throw new Error(`registering ${url}: the response has no id`);
    }
    return body['id'];
  }

  async subscribe(
    apiKey: string,
    endpointId: string,
    eventTypes: readonly string[],
  ): Promise<void> {
    const response = await this.call(
      'PUT',
      `/v1/endpoints/${endpointId}/subscriptions`,
      apiKey,
      { event_types: eventTypes },
    );
    expectStatus(response, 200, `subscribing endpoint ${endpointId}`);
  }

  /**
   * Sends one event. Never throws: under load every outcome, a refused
   * connection included, is a result the run counts.
   */
  async sendEvent(apiKey: string, type: string): Promise<SendResult> {
    let response: ApiResponse;
    try {
      response = await this.call('POST', '/v1/events', apiKey, {
        type,
        payload: { load_test: true },
      });
    } catch (error) {
      return { kind: 'failed', reason: describeError(error) };
    }
    if (response.status === 429) return { kind: 'rate_limited' };
    if (response.status !== 202) {
      return { kind: 'failed', reason: `HTTP ${response.status}` };
    }
    const body = parseJson(response.body);
    if (!isObject(body) || typeof body['event_id'] !== 'string') {
      return { kind: 'failed', reason: 'the 202 has no event_id' };
    }
    return { kind: 'accepted', eventId: body['event_id'] };
  }

  /** Closes the kept-alive sockets, so the process can exit. */
  close(): void {
    this.agent.destroy();
  }

  private call(
    method: 'POST' | 'PUT',
    path: string,
    apiKey: string,
    body: object,
  ): Promise<ApiResponse> {
    const payload = JSON.stringify(body);
    // Keeps any path prefix of the base URL.
    const url = new URL(
      `${this.base.pathname.replace(/\/+$/, '')}${path}`,
      this.base,
    );
    return new Promise((resolve, reject) => {
      const request = this.transport.request(
        url,
        {
          method,
          agent: this.agent,
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () =>
            resolve({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString(),
            }),
          );
          response.on('error', reject);
        },
      );
      request.on('error', reject);
      request.end(payload);
    });
  }
}

function expectStatus(
  response: ApiResponse,
  expected: number,
  what: string,
): void {
  if (response.status !== expected) {
    throw new Error(`${what}: HTTP ${response.status} ${response.body}`);
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Not JSON is the same as JSON without the expected field.
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
