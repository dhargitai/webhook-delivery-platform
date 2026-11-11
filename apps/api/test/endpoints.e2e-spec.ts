import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from './support/test-app.js';

const PROBLEM_JSON = /^application\/problem\+json/;

describe('endpoints and subscriptions (e2e)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  const call = (
    method: 'get' | 'post' | 'put' | 'delete',
    path: string,
    key: string | null,
    body?: object,
  ) => {
    const req = request(t.app.getHttpServer())[method](`/v1${path}`);
    if (key !== null) req.set('Authorization', `Bearer ${key}`);
    return body === undefined ? req : req.send(body);
  };

  const createEndpoint = async (
    key: string,
    url = 'https://hooks.acme.test/in',
  ) => {
    const res = await call('post', '/endpoints', key, { url });
    expect(res.status).toBe(201);
    return res.body as { id: string };
  };

  it('registers an endpoint, subscribes it, lists it and deletes it', async () => {
    const { key } = await t.seedTenant();

    const created = await call('post', '/endpoints', key, {
      url: 'https://hooks.acme.test/in',
      description: 'billing',
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      url: 'https://hooks.acme.test/in',
      description: 'billing',
      status: 'active',
    });
    expect(new Date(created.body.created_at).toString()).not.toBe(
      'Invalid Date',
    );
    const id = created.body.id as string;

    const subscribed = await call(
      'put',
      `/endpoints/${id}/subscriptions`,
      key,
      {
        event_types: ['invoice.paid', 'invoice.failed', 'invoice.paid'],
      },
    );
    expect(subscribed.status).toBe(200);
    expect(subscribed.body).toEqual({
      event_types: ['invoice.failed', 'invoice.paid'],
    });

    const subscriptions = await call(
      'get',
      `/endpoints/${id}/subscriptions`,
      key,
    );
    expect(subscriptions.body).toEqual({
      event_types: ['invoice.failed', 'invoice.paid'],
    });

    const listed = await call('get', '/endpoints', key);
    expect(listed.body.data.map((e: { id: string }) => e.id)).toEqual([id]);

    const fetched = await call('get', `/endpoints/${id}`, key);
    expect(fetched.status).toBe(200);
    expect(fetched.body.id).toBe(id);

    expect((await call('delete', `/endpoints/${id}`, key)).status).toBe(204);
    expect((await call('get', `/endpoints/${id}`, key)).status).toBe(404);
    expect((await call('get', '/endpoints', key)).body.data).toEqual([]);
  });

  it('replaces rather than extends the subscription set', async () => {
    const { key } = await t.seedTenant();
    const { id } = await createEndpoint(key);
    await call('put', `/endpoints/${id}/subscriptions`, key, {
      event_types: ['a', 'b'],
    });

    await call('put', `/endpoints/${id}/subscriptions`, key, {
      event_types: ['c'],
    });

    expect(
      (await call('get', `/endpoints/${id}/subscriptions`, key)).body,
    ).toEqual({ event_types: ['c'] });
  });

  describe('tenant isolation', () => {
    it("answers 404 for every route on another tenant's endpoint", async () => {
      const owner = await t.seedTenant();
      const intruder = await t.seedTenant();
      const { id } = await createEndpoint(owner.key);
      await call('put', `/endpoints/${id}/subscriptions`, owner.key, {
        event_types: ['invoice.paid'],
      });

      const attempts = await Promise.all([
        call('get', `/endpoints/${id}`, intruder.key),
        call('delete', `/endpoints/${id}`, intruder.key),
        call('get', `/endpoints/${id}/subscriptions`, intruder.key),
        call('put', `/endpoints/${id}/subscriptions`, intruder.key, {
          event_types: ['hijacked'],
        }),
      ]);

      for (const res of attempts) {
        expect(res.status).toBe(404);
        expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
      }
      expect((await call('get', `/endpoints/${id}`, owner.key)).status).toBe(
        200,
      );
      expect(
        (await call('get', `/endpoints/${id}/subscriptions`, owner.key)).body,
      ).toEqual({ event_types: ['invoice.paid'] });
    });

    it('lists only the callers own endpoints', async () => {
      const a = await t.seedTenant();
      const b = await t.seedTenant();
      const mine = await createEndpoint(a.key);
      await createEndpoint(b.key);

      const listed = await call('get', '/endpoints', a.key);

      expect(listed.body.data.map((e: { id: string }) => e.id)).toEqual([
        mine.id,
      ]);
    });
  });

  describe('validation', () => {
    it.each([
      {
        name: 'plain http',
        url: 'http://hooks.acme.test/in',
        reason: /https/i,
      },
      {
        name: 'credentials in the URL',
        url: 'https://user:pw@hooks.acme.test/in',
        reason: /credentials/i,
      },
      {
        name: 'a disallowed port',
        url: 'https://hooks.acme.test:8080/in',
        reason: /8080/,
      },
      { name: 'a relative URL', url: '/in', reason: /absolute/i },
    ])('answers 422 explaining $name', async ({ url, reason }) => {
      const { key } = await t.seedTenant();

      const res = await call('post', '/endpoints', key, { url });

      expect(res.status).toBe(422);
      expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
      expect(res.body.errors).toEqual([
        expect.objectContaining({
          path: 'url',
          message: expect.stringMatching(reason),
        }),
      ]);
    });

    it('answers 422 for subscription event types that are too many or empty', async () => {
      const { key } = await t.seedTenant();
      const { id } = await createEndpoint(key);

      const tooMany = await call('put', `/endpoints/${id}/subscriptions`, key, {
        event_types: Array.from({ length: 51 }, (_, i) => `t${i}`),
      });
      const empty = await call('put', `/endpoints/${id}/subscriptions`, key, {
        event_types: [''],
      });

      expect(tooMany.status).toBe(422);
      expect(empty.status).toBe(422);
    });

    it('answers 400 for an id that is not a UUID', async () => {
      const { key } = await t.seedTenant();

      const res = await call('get', '/endpoints/not-a-uuid', key);

      expect(res.status).toBe(400);
      expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
    });

    it('answers 404 for a well-formed id that does not exist', async () => {
      const { key } = await t.seedTenant();

      const res = await call('get', `/endpoints/${randomUUID()}`, key);

      expect(res.status).toBe(404);
    });
  });

  it('answers 401 on every route without an API key', async () => {
    const id = randomUUID();

    const responses = await Promise.all([
      call('post', '/endpoints', null, { url: 'https://hooks.acme.test/in' }),
      call('get', '/endpoints', null),
      call('get', `/endpoints/${id}`, null),
      call('delete', `/endpoints/${id}`, null),
      call('put', `/endpoints/${id}/subscriptions`, null, { event_types: [] }),
      call('get', `/endpoints/${id}/subscriptions`, null),
    ]);

    expect(responses.map((r) => r.status)).toEqual([
      401, 401, 401, 401, 401, 401,
    ]);
  });
});
