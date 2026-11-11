import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo, LookupFunction } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SafeHttpClient, type HttpResult } from './safe-http-client.js';

interface Received {
  headers: IncomingMessage['headers'];
  body: Buffer;
  /** The client's port: equal for two requests only if they shared a socket. */
  remotePort: number | undefined;
}

describe('SafeHttpClient.post', () => {
  const servers: Server[] = [];
  const client = new SafeHttpClient();

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
          }),
      ),
    );
  });

  /** A real receiver on a free port; `respond` decides the answer. */
  async function listen(
    respond: (res: ServerResponse, received: Received) => void,
  ): Promise<{ url: string; received: Received[] }> {
    const received: Received[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const entry = {
          headers: req.headers,
          body: Buffer.concat(chunks),
          remotePort: req.socket.remotePort,
        };
        received.push(entry);
        respond(res, entry);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}/hook`, received };
  }

  function answer(status: number, body = '') {
    return (res: ServerResponse) => {
      res.writeHead(status);
      res.end(body);
    };
  }

  it('sends the headers and the exact body bytes', async () => {
    const { url, received } = await listen(answer(200));
    // Not valid UTF-8: a body re-encoded as a string would change these bytes,
    // and the signature is computed over exactly the bytes sent.
    const body = new Uint8Array([0xff, 0xfe, 0x00, 0x7b]);

    await client.post(
      url,
      { 'content-type': 'application/json', 'webhook-id': 'dlv-1' },
      body,
    );

    expect(received).toHaveLength(1);
    expect(received[0]?.headers['content-type']).toBe('application/json');
    expect(received[0]?.headers['webhook-id']).toBe('dlv-1');
    expect([...(received[0]?.body ?? [])]).toEqual([0xff, 0xfe, 0x00, 0x7b]);
  });

  it('sends a string body as UTF-8', async () => {
    const { url, received } = await listen(answer(200));

    await client.post(url, {}, '{"name":"Zoë"}');

    expect(received[0]?.body.toString('utf8')).toBe('{"name":"Zoë"}');
  });

  it.each([200, 201, 204, 299])('treats %i as a success', async (status) => {
    const { url } = await listen(answer(status));

    const result = await client.post(url, {}, '{}');

    expect(result).toMatchObject({ outcome: 'success', status });
  });

  it.each([400, 404, 408, 429, 500, 503])(
    'treats %i as a failed attempt',
    async (status) => {
      const { url } = await listen(answer(status));

      const result = await client.post(url, {}, '{}');

      expect(result).toMatchObject({
        outcome: 'failed',
        kind: 'http_error',
        status,
      });
    },
  );

  it.each([300, 301, 302, 303, 307, 308, 399])(
    'reports a %i redirect instead of following it',
    async (status) => {
      const { url } = await listen(answer(status));

      const result = await client.post(url, {}, '{}');

      expect(result).toMatchObject({
        outcome: 'failed',
        kind: 'redirect',
        status,
      });
    },
  );

  it('never contacts the redirect target', async () => {
    const target = await listen(answer(200));
    const { url } = await listen((res) => {
      res.writeHead(307, { location: target.url });
      res.end();
    });

    await client.post(url, {}, '{}');

    // A followed redirect is how a public URL reaches an internal host.
    expect(target.received).toHaveLength(0);
  });

  it.each([300, 399])('does not treat %i as a success', async (status) => {
    const { url } = await listen(answer(status));

    const result = await client.post(url, {}, '{}');

    expect(result).toMatchObject({ outcome: 'failed', status });
  });

  it('opens a fresh connection for every call', async () => {
    const { url, received } = await listen(answer(200));

    await client.post(url, {}, '{}');
    await client.post(url, {}, '{}');

    // A reused socket would carry the first call's connect-time decisions
    // (the SSRF guard's pinned IP) over to the second.
    expect(received[0]?.remotePort).toBeDefined();
    expect(received[0]?.remotePort).not.toBe(received[1]?.remotePort);
  });

  it('reports how long the attempt took', async () => {
    const { url } = await listen((res) => {
      setTimeout(() => answer(200)(res), 60);
    });

    const result = await client.post(url, {}, '{}');

    expect(result.latencyMs).toBeGreaterThanOrEqual(50);
  });

  it('keeps the first 1 KB of the response body as a snippet', async () => {
    const { url } = await listen(answer(500, 'x'.repeat(3_000)));

    const result = await client.post(url, {}, '{}');

    expect(result).toMatchObject({ snippet: 'x'.repeat(1_024) });
  });

  it('keeps a short response body whole', async () => {
    const { url } = await listen(answer(200, 'ok'));

    const result = await client.post(url, {}, '{}');

    expect(result).toMatchObject({ outcome: 'success', snippet: 'ok' });
  });

  describe('response cap', () => {
    const capped = new SafeHttpClient({ maxResponseBytes: 100 });

    it('accepts a body of exactly the cap', async () => {
      const { url } = await listen(answer(200, 'x'.repeat(100)));

      const result = await capped.post(url, {}, '{}');

      expect(result).toMatchObject({ outcome: 'success', status: 200 });
    });

    it('fails a 2xx whose body is one byte over the cap', async () => {
      const { url } = await listen(answer(200, 'x'.repeat(101)));

      const result = await capped.post(url, {}, '{}');

      expect(result).toMatchObject({
        outcome: 'failed',
        kind: 'response_too_large',
        status: 200,
      });
    });

    it('defaults to 64 KB', async () => {
      const exact = await listen(answer(200, 'x'.repeat(65_536)));
      const over = await listen(answer(200, 'x'.repeat(65_537)));

      expect(await client.post(exact.url, {}, '{}')).toMatchObject({
        outcome: 'success',
      });
      expect(await client.post(over.url, {}, '{}')).toMatchObject({
        kind: 'response_too_large',
      });
    });

    it('counts a chunked body that declares no length', async () => {
      const { url } = await listen((res) => {
        res.writeHead(200);
        res.write('x'.repeat(60));
        res.end('x'.repeat(60));
      });

      const result = await capped.post(url, {}, '{}');

      expect(result).toMatchObject({ kind: 'response_too_large' });
    });

    it('reports an oversized error response as too large, with its status', async () => {
      const { url } = await listen(answer(500, 'x'.repeat(500)));

      const result = await capped.post(url, {}, '{}');

      expect(result).toMatchObject({
        kind: 'response_too_large',
        status: 500,
      });
    });

    it('still returns the start of the body as a snippet', async () => {
      const { url } = await listen(answer(200, 'y'.repeat(500)));

      const result = await capped.post(url, {}, '{}');

      expect(result).toMatchObject({ snippet: 'y'.repeat(100) });
    });

    it('stops reading an endless response and closes the connection', async () => {
      let serverSawClose: () => void = () => {};
      const closed = new Promise<void>((resolve) => {
        serverSawClose = resolve;
      });
      const { url } = await listen((res) => {
        res.writeHead(200);
        const timer = setInterval(() => res.write('x'.repeat(50)), 5);
        res.on('close', () => {
          clearInterval(timer);
          serverSawClose();
        });
      });

      const result = await capped.post(url, {}, '{}');

      expect(result).toMatchObject({ kind: 'response_too_large' });
      await closed;
    });
  });

  describe('timeouts', () => {
    const timed = new SafeHttpClient({
      connectTimeoutMs: 50,
      totalTimeoutMs: 300,
    });
    const never: LookupFunction = () => {
      // Never calls back: the connect phase stalls, as with a black-holed host.
    };

    it('gives up when the connection is not made in time', async () => {
      const { url, received } = await listen(answer(200));
      const stalled = new SafeHttpClient({
        connectTimeoutMs: 50,
        totalTimeoutMs: 300,
        lookup: never,
      });

      // A hostname, not the IP literal: Node only calls `lookup` for names.
      const named = `http://receiver.invalid:${new URL(url).port}/hook`;

      const result = await stalled.post(named, {}, '{}');

      expect(result).toMatchObject({
        outcome: 'failed',
        kind: 'connect_timeout',
      });
      expect(result.latencyMs).toBeGreaterThanOrEqual(40);
      expect(result.latencyMs).toBeLessThan(250);
      expect(received).toHaveLength(0);
    });

    it('gives up on a receiver that accepts and never answers', async () => {
      let serverSawClose: () => void = () => {};
      const closed = new Promise<void>((resolve) => {
        serverSawClose = resolve;
      });
      const { url } = await listen((res) => {
        // Never responds.
        res.on('close', serverSawClose);
      });

      const result = await timed.post(url, {}, '{}');

      // The connection was made, so this is the total limit, not the connect one.
      expect(result).toMatchObject({ outcome: 'failed', kind: 'timeout' });
      expect(result.latencyMs).toBeGreaterThanOrEqual(250);
      // The call is abandoned, not left holding a socket open.
      await closed;
    });

    it('cuts a receiver that drips its body past the total limit', async () => {
      const { url } = await listen((res) => {
        res.writeHead(200);
        const timer = setInterval(() => res.write('.'), 20);
        res.on('close', () => clearInterval(timer));
      });

      const result = await timed.post(url, {}, '{}');

      expect(result).toMatchObject({ outcome: 'failed', kind: 'timeout' });
    });

    it('does not cut a response that is slower than the connect limit', async () => {
      const { url } = await listen((res) => {
        setTimeout(() => answer(200, 'late')(res), 150);
      });

      const result = await timed.post(url, {}, '{}');

      expect(result).toMatchObject({ outcome: 'success', snippet: 'late' });
    });

    it('connects through the given lookup', async () => {
      const { url } = await listen(answer(200, 'via lookup'));
      const resolving: LookupFunction = (_hostname, options, callback) => {
        // Node asks for every address when it may try several families.
        if (options.all) {
          callback(null, [{ address: '127.0.0.1', family: 4 }]);
        } else {
          callback(null, '127.0.0.1', 4);
        }
      };
      const viaLookup = new SafeHttpClient({ lookup: resolving });
      const port = new URL(url).port;

      const result = await viaLookup.post(
        `http://receiver.invalid:${port}/hook`,
        {},
        '{}',
      );

      expect(result).toMatchObject({
        outcome: 'success',
        snippet: 'via lookup',
      });
    });

    it('leaves no timer running after a connection that failed', async () => {
      const { url } = await listen(answer(200));
      const [server] = servers.splice(0);
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      const timers = () =>
        process.getActiveResourcesInfo().filter((name) => name === 'Timeout')
          .length;
      const before = timers();

      const result = await timed.post(url, {}, '{}');
      // Shorter than both limits: a leaked timer is still pending here.
      await new Promise((resolve) => setImmediate(resolve));

      expect(result).toMatchObject({ kind: 'network_error' });
      expect(timers()).toBeLessThanOrEqual(before);
    });

    describe('defaults', () => {
      const fakeTimers = () =>
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      afterEach(() => {
        vi.useRealTimers();
      });

      it('gives up connecting after 3 s', async () => {
        fakeTimers();
        let result: HttpResult | undefined;
        void new SafeHttpClient({ lookup: never })
          .post('http://receiver.invalid:9/hook', {}, '{}')
          .then((outcome) => (result = outcome));

        await vi.advanceTimersByTimeAsync(2_999);
        expect(result).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1);

        expect(result).toMatchObject({ kind: 'connect_timeout' });
      });

      it('gives up on the whole call after 10 s', async () => {
        let accepted: () => void = () => {};
        const arrived = new Promise<void>((resolve) => {
          accepted = resolve;
        });
        const { url } = await listen(() => accepted());
        fakeTimers();
        let result: HttpResult | undefined;
        void client.post(url, {}, '{}').then((outcome) => (result = outcome));
        await arrived;

        await vi.advanceTimersByTimeAsync(9_999);
        expect(result).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1);

        expect(result).toMatchObject({ kind: 'timeout' });
      });
    });

    it('leaves no timer running after a call', async () => {
      const { url } = await listen(answer(200));
      const timers = () =>
        process.getActiveResourcesInfo().filter((name) => name === 'Timeout')
          .length;
      const before = timers();

      await timed.post(url, {}, '{}');
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(timers()).toBeLessThanOrEqual(before);
    });
  });

  it('reports a refused connection as a network error', async () => {
    const { url } = await listen(answer(200));
    // Closing the only listener leaves a port nothing answers on.
    const [server] = servers.splice(0);
    await new Promise<void>((resolve) => server?.close(() => resolve()));

    const result = await client.post(url, {}, '{}');

    expect(result).toMatchObject({ outcome: 'failed', kind: 'network_error' });
    expect(result.outcome === 'failed' && result.error).toMatch(/\S/);
  });
});

describe('SafeHttpClient options', () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses %s as maxResponseBytes',
    (value) => {
      expect(() => new SafeHttpClient({ maxResponseBytes: value })).toThrow(
        RangeError,
      );
    },
  );

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses %s as snippetBytes',
    (value) => {
      expect(() => new SafeHttpClient({ snippetBytes: value })).toThrow(
        RangeError,
      );
    },
  );
});

describe('SafeHttpClient timeout options', () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses %s as connectTimeoutMs',
    (value) => {
      expect(() => new SafeHttpClient({ connectTimeoutMs: value })).toThrow(
        RangeError,
      );
    },
  );

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses %s as totalTimeoutMs',
    (value) => {
      expect(() => new SafeHttpClient({ totalTimeoutMs: value })).toThrow(
        RangeError,
      );
    },
  );

  it('refuses a connect limit above the total limit', () => {
    // It could never fire: the total limit would always cut the call first.
    expect(
      () => new SafeHttpClient({ connectTimeoutMs: 500, totalTimeoutMs: 100 }),
    ).toThrow(RangeError);
  });

  it('accepts a connect limit equal to the total limit', () => {
    expect(
      () => new SafeHttpClient({ connectTimeoutMs: 100, totalTimeoutMs: 100 }),
    ).not.toThrow();
  });
});
