import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { LookupAddress } from 'node:dns';
import type { AddressInfo, LookupFunction } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SafeHttpClient, type HttpResult } from './safe-http-client.js';
import { SsrfGuard } from './ssrf-guard.js';

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

  describe('SSRF protection', () => {
    /** A client wired to the guard the way the worker will wire it. */
    function guardedClient(guard: SsrfGuard) {
      return new SafeHttpClient({
        lookup: guard.lookup,
        hostCheck: (hostname) => guard.blockedHostReason(hostname),
        connectTimeoutMs: 300,
        totalTimeoutMs: 600,
      });
    }
    const resolvingTo = (...addresses: LookupAddress[]) =>
      new SsrfGuard({ resolve: () => Promise.resolve(addresses) });
    const neverResolving = new SsrfGuard({
      resolve: () =>
        Promise.reject(new Error('a literal host must not be resolved')),
    });

    it.each([
      [
        'an IPv4 loopback literal',
        (port: string) => `http://127.0.0.1:${port}/hook`,
        /loopback/,
      ],
      [
        'an IPv6 loopback literal',
        (port: string) => `http://[::1]:${port}/hook`,
        /loopback/,
      ],
      [
        'a decimal IPv4 literal',
        (port: string) => `http://2130706433:${port}/hook`,
        /loopback/,
      ],
      [
        'a hex and short IPv4 literal',
        (port: string) => `http://0x7f.1:${port}/hook`,
        /loopback/,
      ],
      [
        'a mapped IPv6 literal',
        (port: string) => `http://[::ffff:10.0.0.1]:${port}/hook`,
        /private network/,
      ],
      [
        'the cloud metadata address',
        (port: string) => `http://169.254.169.254:${port}/latest/meta-data`,
        /link-local/,
      ],
    ])('never connects to %s', async (_name, urlFor, reason) => {
      const { url, received } = await listen(answer(200));

      const result = await guardedClient(neverResolving).post(
        urlFor(new URL(url).port),
        {},
        '{}',
      );

      expect(result).toMatchObject({ outcome: 'failed', kind: 'ssrf_blocked' });
      expect(result).toMatchObject({ error: expect.stringMatching(reason) });
      expect(received).toHaveLength(0);
    });

    it('refuses a name that resolves to a private address, without connecting', async () => {
      const { url, received } = await listen(answer(200));
      const guard = resolvingTo({ address: '10.0.0.1', family: 4 });

      const result = await guardedClient(guard).post(
        `http://private.test:${new URL(url).port}/hook`,
        {},
        '{}',
      );

      expect(result).toMatchObject({ outcome: 'failed', kind: 'ssrf_blocked' });
      expect(result).toMatchObject({
        error: expect.stringMatching(/10\.0\.0\.1.*private network/),
      });
      expect(received).toHaveLength(0);
    });

    it('reaches an allowlisted host, connecting to the address it resolved to', async () => {
      const { url, received } = await listen(answer(200, 'allowed'));
      const guard = new SsrfGuard({
        resolve: () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]),
        allowHosts: ['mock-receiver'],
      });

      const result = await guardedClient(guard).post(
        `http://mock-receiver:${new URL(url).port}/hook`,
        {},
        '{}',
      );

      expect(result).toMatchObject({ outcome: 'success', snippet: 'allowed' });
      expect(received).toHaveLength(1);
      expect(received[0]?.headers.host).toBe(
        `mock-receiver:${new URL(url).port}`,
      );
    });

    it('still calls a public host the guard lets through', async () => {
      const { url, received } = await listen(answer(200));
      // Public to the guard; the connection itself is steered to the test server.
      const guard = new SsrfGuard({
        resolve: () =>
          Promise.resolve([{ address: '93.184.216.34', family: 4 }]),
      });
      const steered = new SafeHttpClient({
        lookup: (hostname, options, callback) =>
          guard.lookup(hostname, options, (error, address, family) => {
            if (error) return callback(error, '');
            callback(
              null,
              options.all ? [{ address: '127.0.0.1', family: 4 }] : '127.0.0.1',
              family,
            );
          }),
        hostCheck: (hostname) => guard.blockedHostReason(hostname),
      });

      const result = await steered.post(
        `http://public.test:${new URL(url).port}/hook`,
        {},
        '{}',
      );

      expect(result).toMatchObject({ outcome: 'success' });
      expect(received).toHaveLength(1);
    });

    it('keeps an ordinary lookup failure a network error', async () => {
      const failing = new SafeHttpClient({
        lookup: (_hostname, _options, callback) =>
          callback(
            Object.assign(new Error('getaddrinfo ENOTFOUND gone.test'), {
              code: 'ENOTFOUND',
            }),
            '',
          ),
      });

      const result = await failing.post('http://gone.test/hook', {}, '{}');

      expect(result).toMatchObject({
        outcome: 'failed',
        kind: 'network_error',
      });
    });

    it('calls no host check unless one is given', async () => {
      const { url } = await listen(answer(200));

      // The default client connects to a loopback literal, as every other test does.
      await expect(client.post(url, {}, '{}')).resolves.toMatchObject({
        outcome: 'success',
      });
    });
  });

  describe('an unusable URL', () => {
    it.each([
      '',
      'not a url',
      '/relative/path',
      'ftp://example.com/x',
      'file:///etc/passwd',
      'javascript:alert(1)',
    ])('is a failed result, not a throw: %j', async (url) => {
      const result = await client.post(url, {}, '{}');

      expect(result).toMatchObject({ outcome: 'failed', kind: 'invalid_url' });
      expect(result.outcome === 'failed' && result.error).toMatch(/\S/);
    });

    it('accepts an https URL', async () => {
      // Nothing listens on port 1, so this ends as a refused connection: the
      // URL itself was usable.
      const result = await client.post('https://127.0.0.1:1/hook', {}, '{}');

      expect(result).toMatchObject({ kind: 'network_error' });
    });

    it('starts no timer', async () => {
      const timers = () =>
        process.getActiveResourcesInfo().filter((name) => name === 'Timeout')
          .length;
      const before = timers();

      await client.post('not a url', {}, '{}');

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
