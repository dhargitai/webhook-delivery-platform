export type SendResult =
  | { kind: 'accepted'; eventId: string }
  | { kind: 'rate_limited' }
  | { kind: 'failed'; reason: string };

/**
 * The few public API calls a load test makes, as the tenant's own code would
 * make them: over HTTP with the tenant's API key.
 */
export class LoadApiClient {
  private readonly base: string;

  constructor(baseUrl: string) {
    this.base = baseUrl.replace(/\/+$/, '');
  }

  /** Registers an endpoint and returns its id. */
  async createEndpoint(apiKey: string, url: string): Promise<string> {
    const response = await this.call('POST', '/v1/endpoints', apiKey, { url });
    await expectStatus(response, 201, `registering ${url}`);
    const body: unknown = await response.json();
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
    await expectStatus(response, 200, `subscribing endpoint ${endpointId}`);
    await response.body?.cancel();
  }

  /**
   * Sends one event. Never throws: under load every outcome, a refused
   * connection included, is a result the run counts.
   */
  async sendEvent(apiKey: string, type: string): Promise<SendResult> {
    try {
      const response = await this.call('POST', '/v1/events', apiKey, {
        type,
        payload: { load_test: true },
      });
      if (response.status === 429) {
        await response.body?.cancel();
        return { kind: 'rate_limited' };
      }
      if (response.status !== 202) {
        await response.body?.cancel();
        return { kind: 'failed', reason: `HTTP ${response.status}` };
      }
      const body: unknown = await response.json();
      if (!isObject(body) || typeof body['event_id'] !== 'string') {
        return { kind: 'failed', reason: 'the 202 has no event_id' };
      }
      return { kind: 'accepted', eventId: body['event_id'] };
    } catch (error) {
      return {
        kind: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private call(
    method: 'POST' | 'PUT',
    path: string,
    apiKey: string,
    body: object,
  ): Promise<Response> {
    return fetch(`${this.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  }
}

async function expectStatus(
  response: Response,
  expected: number,
  what: string,
): Promise<void> {
  if (response.status !== expected) {
    const detail = await response.text();
    throw new Error(`${what}: HTTP ${response.status} ${detail}`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
