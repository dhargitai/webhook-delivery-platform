import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from './support/test-app.js';

/** The dev-only SSRF allowlist, which lets the Compose mock receiver be registered. */
describe('endpoint URL allowlist (e2e)', () => {
  let t: TestApp;
  let key: string;

  beforeAll(async () => {
    t = await startTestApp({ SSRF_ALLOW_HOSTS: 'mock-receiver, LOCALHOST' });
    ({ key } = await t.seedTenant());
  });

  afterAll(async () => {
    await t.close();
  });

  const register = (url: string) =>
    request(t.app.getHttpServer())
      .post('/v1/endpoints')
      .set('Authorization', `Bearer ${key}`)
      .send({ url });

  it('registers an http endpoint on an allowed host', async () => {
    const res = await register('http://mock-receiver:4000/hook');

    expect(res.status).toBe(201);
    expect(res.body.url).toBe('http://mock-receiver:4000/hook');
  });

  it('matches allowed hosts case-insensitively', async () => {
    const res = await register('http://localhost:3000/in');

    expect(res.status).toBe(201);
  });

  it('still refuses a host that is not on the list', async () => {
    const res = await register('http://some-other-host:4000/hook');

    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual([
      expect.objectContaining({
        path: 'url',
        message: expect.stringMatching(/https/i),
      }),
    ]);
  });

  it('still refuses credentials on an allowed host', async () => {
    const res = await register('http://user:pw@mock-receiver:4000/hook');

    expect(res.status).toBe(422);
  });

  it('still accepts ordinary https endpoints', async () => {
    const res = await register('https://hooks.acme.test/in');

    expect(res.status).toBe(201);
  });
});
