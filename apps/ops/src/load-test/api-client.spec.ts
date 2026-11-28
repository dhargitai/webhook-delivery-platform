import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { LoadApiClient } from './api-client.js';

interface Seen {
  method: string;
  url: string;
  authorization: string | undefined;
  contentType: string | undefined;
  body: unknown;
}

/** A stand-in API on loopback that answers each request with `respond`. */
async function fakeApi(
  respond: (req: Seen, res: ServerResponse) => void,
): Promise<{
  base: string;
  seen: Seen[];
  sockets: () => number;
  server: Server;
}> {
  const seen: Seen[] = [];
  let sockets = 0;
  const server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString();
      const entry = {
        method: req.method ?? '',
        url: req.url ?? '',
        authorization: req.headers.authorization,
        contentType: req.headers['content-type'],
        body: text === '' ? undefined : (JSON.parse(text) as unknown),
      };
      seen.push(entry);
      respond(entry, res);
    });
  });
  server.on('connection', () => (sockets += 1));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    seen,
    sockets: () => sockets,
    server,
  };
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

describe('LoadApiClient', () => {
  const cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  async function setUp(respond: (req: Seen, res: ServerResponse) => void) {
    const api = await fakeApi(respond);
    // A trailing slash, as a URL from the environment may have.
    const client = new LoadApiClient(`${api.base}/`);
    cleanups.push(async () => {
      client.close();
      api.server.closeAllConnections();
      await new Promise<void>((resolve) => api.server.close(() => resolve()));
    });
    return { api, client };
  }

  it('registers an endpoint with the key and returns its id', async () => {
    const { api, client } = await setUp((_req, res) =>
      json(res, 201, { id: 'ep-1', secret: 'whsec_x' }),
    );

    await expect(
      client.createEndpoint('whk_key', 'http://receiver/hook'),
    ).resolves.toBe('ep-1');
    expect(api.seen).toEqual([
      {
        method: 'POST',
        url: '/v1/endpoints',
        authorization: 'Bearer whk_key',
        contentType: 'application/json',
        body: { url: 'http://receiver/hook' },
      },
    ]);
  });

  it('explains a refused registration with its status and body', async () => {
    const { client } = await setUp((_req, res) =>
      json(res, 422, { title: 'url_not_allowed' }),
    );

    await expect(
      client.createEndpoint('whk_key', 'http://10.0.0.1/'),
    ).rejects.toThrow(/HTTP 422.*url_not_allowed/);
  });

  it('subscribes an endpoint to its event types', async () => {
    const { api, client } = await setUp((_req, res) =>
      json(res, 200, { event_types: ['a'] }),
    );

    await client.subscribe('whk_key', 'ep-1', ['load.t0']);

    expect(api.seen[0]).toMatchObject({
      method: 'PUT',
      url: '/v1/endpoints/ep-1/subscriptions',
      body: { event_types: ['load.t0'] },
    });
  });

  it('refuses a failed subscription', async () => {
    const { client } = await setUp((_req, res) => json(res, 404, {}));

    await expect(client.subscribe('whk_key', 'ep-1', ['a'])).rejects.toThrow(
      /HTTP 404/,
    );
  });

  it.each([
    {
      name: 'a 202 as accepted, with its event id',
      status: 202,
      body: { event_id: 'evt-1' },
      result: { kind: 'accepted', eventId: 'evt-1' },
    },
    {
      name: 'a 429 as rate limited',
      status: 429,
      body: { title: 'Too Many Requests' },
      result: { kind: 'rate_limited' },
    },
    {
      name: 'any other status as failed',
      status: 500,
      body: {},
      result: { kind: 'failed', reason: 'HTTP 500' },
    },
    {
      name: 'a 202 without an event id as failed',
      status: 202,
      body: {},
      result: { kind: 'failed', reason: 'the 202 has no event_id' },
    },
  ])('reports $name', async ({ status, body, result }) => {
    const { api, client } = await setUp((_req, res) => json(res, status, body));

    await expect(client.sendEvent('whk_key', 'load.t0')).resolves.toEqual(
      result,
    );
    expect(api.seen[0]).toMatchObject({
      method: 'POST',
      url: '/v1/events',
      authorization: 'Bearer whk_key',
      body: { type: 'load.t0' },
    });
  });

  it('reports an unreachable API as failed instead of throwing', async () => {
    const { api, client } = await setUp((_req, res) => json(res, 202, {}));
    api.server.closeAllConnections();
    await new Promise<void>((resolve) => api.server.close(() => resolve()));

    await expect(client.sendEvent('whk_key', 'load.t0')).resolves.toEqual({
      kind: 'failed',
      reason: expect.stringMatching(/ECONNREFUSED/),
    });
  });

  it('keeps connections alive across sends', async () => {
    // A new TCP connection per event would cost the generator, and the API,
    // more than the event itself at hundreds per second.
    const { api, client } = await setUp((_req, res) =>
      json(res, 202, { event_id: 'evt' }),
    );

    for (let i = 0; i < 20; i++) {
      await client.sendEvent('whk_key', 'load.t0');
    }

    expect(api.sockets()).toBe(1);
  });
});
