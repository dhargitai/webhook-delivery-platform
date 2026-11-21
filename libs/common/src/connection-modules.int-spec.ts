import net from 'node:net';
import { type DynamicModule, Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Database } from '@wdp/core';
import { createTestDatabase, type TestDatabase } from '@wdp/core/testing';
import type { BrokerConnection } from '@wdp/messaging';
import { eventually, testingNamespace } from '@wdp/messaging/testing';
import { type Kysely, sql } from 'kysely';
import type { Redis } from 'ioredis';
import type { MongoClient } from 'mongodb';
import pg from 'pg';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  inject,
  it,
  vi,
} from 'vitest';
import { BrokerModule } from './broker.module.js';
import { DatabaseModule } from './database.module.js';
import { MongoModule } from './mongo.module.js';
import { RedisModule } from './redis.module.js';
import { BROKER, DATABASE, MONGO, REDIS } from './tokens.js';

interface TestConfig {
  databaseUrl: string;
  rabbitmqUrl: string;
  mongoUrl: string;
  redisUrl: string;
}

/** A TCP proxy in front of a server, whose connections a test can cut. */
interface TcpProxy {
  /** `target` with its host and port replaced by the proxy's. */
  url: string;
  /** Closes every proxied connection, as a broker restart or a network drop would. */
  dropConnections(): void;
  close(): Promise<void>;
}

async function startTcpProxy(target: string): Promise<TcpProxy> {
  const upstream = new URL(target);
  const sockets = new Set<net.Socket>();
  const track = (socket: net.Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  };
  const server = net.createServer((client) => {
    const remote = net.connect(Number(upstream.port), upstream.hostname);
    track(client);
    track(remote);
    client.pipe(remote);
    remote.pipe(client);
    // One side failing ends the pair; the error itself is what the test causes.
    const drop = () => {
      client.destroy();
      remote.destroy();
    };
    client.on('error', drop);
    remote.on('error', drop);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the proxy is not listening on a TCP port');
  }
  const url = new URL(target);
  url.hostname = '127.0.0.1';
  url.port = String(address.port);

  const dropConnections = () => {
    for (const socket of sockets) socket.destroy();
  };
  return {
    url: url.toString(),
    dropConnections,
    close: async () => {
      dropConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

/** Stands in for an app's config namespace, as the factories' only input. */
const CONFIG = Symbol('CONFIG');
class TestConfigModule {}

describe('connection modules (real Postgres, RabbitMQ and MongoDB)', () => {
  let testDb: TestDatabase;
  let config: TestConfig;
  let app: TestingModule | undefined;

  beforeAll(async () => {
    testDb = await createTestDatabase(inject('postgresAdminUrl'));
    config = {
      databaseUrl: testDb.url,
      rabbitmqUrl: inject('rabbitUrl'),
      mongoUrl: inject('mongoUrl'),
      redisUrl: inject('redisUrl'),
    };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app?.close();
    app = undefined;
  });

  afterAll(async () => {
    await testDb.drop();
  });

  function configModule(): DynamicModule {
    return {
      module: TestConfigModule,
      global: true,
      providers: [{ provide: CONFIG, useValue: config }],
      exports: [CONFIG],
    };
  }

  const database = () =>
    DatabaseModule.forRootAsync({
      inject: [CONFIG],
      url: (c: TestConfig) => c.databaseUrl,
    });
  const broker = () =>
    BrokerModule.forRootAsync({
      inject: [CONFIG],
      url: (c: TestConfig) => c.rabbitmqUrl,
    });
  const mongo = () =>
    MongoModule.forRootAsync({
      inject: [CONFIG],
      url: (c: TestConfig) => c.mongoUrl,
    });
  const redis = () =>
    RedisModule.forRootAsync({
      inject: [CONFIG],
      url: (c: TestConfig) => c.redisUrl,
    });

  async function start(...imports: DynamicModule[]): Promise<TestingModule> {
    const moduleRef = await Test.createTestingModule({
      imports: [configModule(), ...imports],
    }).compile();
    await moduleRef.init();
    app = moduleRef;
    return moduleRef;
  }

  /** What a Postgres restart does to the connections the pool keeps idle. */
  async function killDatabaseConnections(): Promise<void> {
    const admin = new pg.Client({
      connectionString: inject('postgresAdminUrl'),
    });
    await admin.connect();
    try {
      await admin.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
        [new URL(testDb.url).pathname.slice(1)],
      );
    } finally {
      await admin.end();
    }
  }

  it('logs an idle database connection that died, and keeps working', async () => {
    // Silenced: the error is expected, and its stack would clutter the run.
    const logged = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const db = (await start(database())).get<Kysely<Database>>(DATABASE);
    // One query leaves a client idle in the pool.
    await sql`SELECT 1`.execute(db);

    await killDatabaseConnections();

    await eventually(() => {
      expect(logged).toHaveBeenCalledWith(
        'database pool error',
        expect.any(String),
      );
    });
    const result = await sql<{ one: number }>`SELECT 1 AS one`.execute(db);
    expect(result.rows).toEqual([{ one: 1 }]);
  });

  it('closes the database pool when the app shuts down', async () => {
    const db = (await start(database())).get<Kysely<Database>>(DATABASE);
    await sql`SELECT 1`.execute(db);

    await app?.close();
    app = undefined;

    await expect(sql`SELECT 1`.execute(db)).rejects.toThrow();
  });

  it('closes the broker connection when the app shuts down', async () => {
    const connection = (await start(broker())).get<BrokerConnection>(BROKER);
    await (await connection.createChannel()).close();

    await app?.close();
    app = undefined;

    await expect(connection.createChannel()).rejects.toThrow();
  });

  it('logs a channel the broker closed, and keeps the connection', async () => {
    // Silenced: the error is expected, and its stack would clutter the run.
    const logged = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const connection = (await start(broker())).get<BrokerConnection>(BROKER);
    const channel = await connection.createChannel();

    // The broker answers a check of a missing queue by closing the channel
    // with a 404, which amqplib also emits as the channel's `error` event.
    await expect(
      channel.checkQueue(`${testingNamespace()}.missing`),
    ).rejects.toThrow(/NOT_FOUND/);

    await eventually(() => {
      expect(logged).toHaveBeenCalledWith(
        'broker connection error',
        expect.any(String),
      );
    });
    // Only that channel is gone: an unheard channel error would have been
    // thrown inside amqplib and taken the whole connection down.
    await (await connection.createChannel()).close();
  });

  it('logs a broker connection that dropped', async () => {
    const logged = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const proxy = await startTcpProxy(config.rabbitmqUrl);
    const direct = config;
    config = { ...config, rabbitmqUrl: proxy.url };
    try {
      const connection = (await start(broker())).get<BrokerConnection>(BROKER);
      await (await connection.createChannel()).close();

      proxy.dropConnections();

      await eventually(() => {
        expect(logged).toHaveBeenCalledWith(
          'broker connection error',
          expect.any(String),
        );
      });
    } finally {
      config = direct;
      await proxy.close();
    }
  });

  it('closes the MongoDB client when the app shuts down', async () => {
    const client = (await start(mongo())).get<MongoClient>(MONGO);
    await client.db('admin').command({ ping: 1 });
    const closed = new Promise<void>((resolve) => {
      client.once('topologyClosed', () => resolve());
    });

    await app?.close();
    app = undefined;

    await closed;
  });

  it('closes the Redis client when the app shuts down', async () => {
    const client = (await start(redis())).get<Redis>(REDIS);
    expect(await client.ping()).toBe('PONG');

    await app?.close();
    app = undefined;

    expect(client.status).toBe('end');
    await expect(client.ping()).rejects.toThrow();
  });

  it('logs an unreachable Redis, then shuts down and stops reconnecting', async () => {
    // Silenced: the errors are expected, and would clutter the run.
    const logged = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const reachable = config;
    // Nothing listens on port 1, so every connection attempt is refused.
    config = { ...config, redisUrl: 'redis://127.0.0.1:1' };
    try {
      await start(redis());

      await eventually(() => {
        expect(logged).toHaveBeenCalledWith(
          'redis connection error',
          expect.any(String),
        );
      });

      await app?.close();
      app = undefined;
      // ioredis retries after 50 ms, then 100 ms, ...: a client still
      // reconnecting would log again well within this wait.
      const errorsAtClose = logged.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(logged.mock.calls.length).toBe(errorsAtClose);
    } finally {
      config = reachable;
    }
  });

  it('builds the Redis client with the options it is given', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const reachable = config;
    config = { ...config, redisUrl: 'redis://127.0.0.1:1' };
    try {
      const moduleRef = await start(
        RedisModule.forRootAsync({
          inject: [CONFIG],
          url: (c: TestConfig) => c.redisUrl,
          clientOptions: { maxRetriesPerRequest: 1 },
        }),
      );
      const client = moduleRef.get<Redis>(REDIS);

      // With the default of 20 retries, a command waits through about 10 s
      // of reconnect attempts before it is rejected.
      const startedAt = Date.now();
      await expect(client.ping()).rejects.toThrow();
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    } finally {
      config = reachable;
    }
  });

  it('makes the connections injectable from any module', async () => {
    const USES = Symbol('USES');
    class ConsumerModule {}
    const moduleRef = await start(database(), broker(), mongo(), redis(), {
      module: ConsumerModule,
      providers: [
        {
          provide: USES,
          inject: [DATABASE, BROKER, MONGO, REDIS],
          useFactory: (...connections: unknown[]) => connections,
        },
      ],
    });

    const connections = moduleRef.get<unknown[]>(USES);

    expect(connections).toHaveLength(4);
    expect(connections[0]).toBe(moduleRef.get(DATABASE));
    expect(connections[1]).toBe(moduleRef.get(BROKER));
    expect(connections[2]).toBe(moduleRef.get(MONGO));
    expect(connections[3]).toBe(moduleRef.get(REDIS));
  });
});
