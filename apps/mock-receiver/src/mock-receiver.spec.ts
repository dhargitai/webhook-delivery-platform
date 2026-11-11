import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createMockReceiver,
  type MockReceiver,
  type WebhookLogEntry,
} from './mock-receiver.js';

describe('mock receiver (real HTTP)', () => {
  let receiver: MockReceiver;
  let base: string;
  let roll = 0.5;
  const log: WebhookLogEntry[] = [];

  beforeEach(async () => {
    roll = 0.5;
    log.length = 0;
    receiver = createMockReceiver({
      random: () => roll,
      onWebhook: (entry) => log.push(entry),
    });
    const port = await receiver.listen(0);
    base = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await receiver.close();
  });

  const hook = (
    query = '',
    init: {
      body?: string;
      headers?: Record<string, string>;
      signal?: AbortSignal;
    } = {},
  ) =>
    fetch(`${base}/hook${query}`, {
      method: 'POST',
      body: init.body ?? '{"a":1}',
      headers: { 'content-type': 'application/json', ...init.headers },
      signal: init.signal,
    });

  const stats = async () => (await fetch(`${base}/stats`)).json();

  describe('answers', () => {
    it('200 by default', async () => {
      const res = await hook();

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ received: true });
    });

    it('a fixed status when asked', async () => {
      expect((await hook('?status=429')).status).toBe(429);
      expect((await hook('?status=204')).status).toBe(204);
    });

    it('under any path below /hook', async () => {
      const res = await fetch(`${base}/hook/acme/invoices?fail=0`, {
        method: 'POST',
        body: '{}',
      });

      expect(res.status).toBe(200);
    });
  });

  describe('failing', () => {
    it('never when the fail rate is 0 and always when it is 1', async () => {
      expect((await hook('?fail=0')).status).toBe(200);
      expect((await hook('?fail=1')).status).toBe(500);
    });

    it('when the dice land below the fail rate, and not otherwise', async () => {
      roll = 0.4;
      expect((await hook('?fail=0.5')).status).toBe(500);
      roll = 0.6;
      expect((await hook('?fail=0.5')).status).toBe(200);
    });

    it('with the status it is told to fail with', async () => {
      expect((await hook('?fail=1&failStatus=503')).status).toBe(503);
    });
  });

  describe('latency', () => {
    it('waits before answering', async () => {
      const started = Date.now();

      const res = await hook('?latency=300');

      expect(res.status).toBe(200);
      expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    });
  });

  describe('hanging', () => {
    it('never answers, so the caller has to give up', async () => {
      await expect(
        hook('?hang=1', { signal: AbortSignal.timeout(300) }),
      ).rejects.toThrow();

      expect((await stats()).hung).toBe(1);
    });

    it('does not stop the receiver from closing', async () => {
      hook('?hang=1', { signal: AbortSignal.timeout(5_000) }).catch(
        () => undefined,
      );
      await new Promise((resolve) => setTimeout(resolve, 200));

      const started = Date.now();
      await receiver.close();

      expect(Date.now() - started).toBeLessThan(2_000);
    });
  });

  describe('bad parameters', () => {
    it('answers 400 with problem details naming the parameter, and counts nothing', async () => {
      const res = await hook('?fail=7&latency=-1');

      expect(res.status).toBe(400);
      expect(res.headers.get('content-type')).toMatch(
        /application\/problem\+json/,
      );
      const body = await res.json();
      expect(body.errors.map((e: { param: string }) => e.param).sort()).toEqual(
        ['fail', 'latency'],
      );
      expect((await stats()).received).toBe(0);
    });
  });

  describe('statistics', () => {
    it('count what arrived and how it went', async () => {
      await hook();
      await hook();
      await hook('?fail=1');
      await hook('?status=429');

      expect(await stats()).toMatchObject({
        received: 4,
        succeeded: 2,
        failed: 2,
        hung: 0,
      });
    });

    it('count deliveries per webhook-id, so a retry shows up as a repeat', async () => {
      await hook('', { headers: { 'webhook-id': 'msg_1' } });
      await hook('?fail=1', { headers: { 'webhook-id': 'msg_1' } });
      await hook('', { headers: { 'webhook-id': 'msg_2' } });
      await hook();

      expect((await stats()).byWebhookId).toEqual({ msg_1: 2, msg_2: 1 });
    });

    it('can be reset', async () => {
      await hook('', { headers: { 'webhook-id': 'msg_1' } });

      const reset = await fetch(`${base}/stats/reset`, { method: 'POST' });

      expect(reset.status).toBe(204);
      expect(await stats()).toEqual({
        received: 0,
        succeeded: 0,
        failed: 0,
        hung: 0,
        byWebhookId: {},
      });
    });
  });

  describe('request log', () => {
    it('reports each webhook with its id, size and outcome', async () => {
      await hook('', {
        body: '{"hello":"world"}',
        headers: { 'webhook-id': 'msg_9' },
      });
      await hook('?status=503');

      expect(log).toEqual([
        { webhookId: 'msg_9', bytes: 17, outcome: 'succeeded', status: 200 },
        { webhookId: undefined, bytes: 7, outcome: 'failed', status: 503 },
      ]);
    });
  });

  describe('large bodies', () => {
    it('are read and discarded without trouble', async () => {
      const res = await hook('', { body: 'x'.repeat(2 * 1024 * 1024) });

      expect(res.status).toBe(200);
      expect(log[0]?.bytes).toBe(2 * 1024 * 1024);
    });
  });

  describe('other routes', () => {
    it('reports health', async () => {
      const res = await fetch(`${base}/health`);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'ok' });
    });

    it('refuses GET on the hook with 405', async () => {
      const res = await fetch(`${base}/hook`);

      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
    });

    it('answers 404 for anything else', async () => {
      expect((await fetch(`${base}/nope`)).status).toBe(404);
    });
  });
});
