import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { InvalidBehaviourError, parseBehaviour } from './behaviour.js';

export interface Stats {
  received: number;
  succeeded: number;
  failed: number;
  hung: number;
  /** Deliveries per `webhook-id`, so a retry shows up as a count above 1. */
  byWebhookId: Record<string, number>;
}

export interface WebhookLogEntry {
  webhookId: string | undefined;
  bytes: number;
  outcome: 'succeeded' | 'failed' | 'hung';
  /** Absent when the request hung and was never answered. */
  status?: number;
}

export interface MockReceiverOptions {
  /** Source of the dice for `fail`; injectable so tests are deterministic. */
  random?: () => number;
  /** Called once per webhook, for logging. */
  onWebhook?: (entry: WebhookLogEntry) => void;
}

export interface MockReceiver {
  /** Starts listening and resolves with the port (0 picks a free one). */
  listen(port: number, host?: string): Promise<number>;
  close(): Promise<void>;
  stats(): Stats;
}

const HOOK_PREFIX = '/hook';
// Bounds the memory of a long demo: ids beyond this are counted in aggregate only.
const MAX_TRACKED_IDS = 1_000;

function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  type = 'application/json',
) {
  res.writeHead(status, { 'content-type': type });
  res.end(JSON.stringify(body));
}

/** Reads and discards a request body, resolving with its size. */
function drain(req: IncomingMessage): Promise<number> {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
    });
    req.on('end', () => resolve(bytes));
    req.on('error', reject);
  });
}

/**
 * A stand-in for a customer's webhook endpoint. What it does with each request
 * is set by the URL's query string (see `parseBehaviour`), so a demo can make
 * it slow, flaky, or deaf on demand.
 */
export function createMockReceiver({
  random = Math.random,
  onWebhook,
}: MockReceiverOptions = {}): MockReceiver {
  const fresh = (): Stats => ({
    received: 0,
    succeeded: 0,
    failed: 0,
    hung: 0,
    byWebhookId: {},
  });
  let stats = fresh();
  const hung = new Set<ServerResponse>();
  let closing: Promise<void> | undefined;

  function track(webhookId: string | undefined) {
    if (webhookId === undefined) return;
    const known = webhookId in stats.byWebhookId;
    if (known || Object.keys(stats.byWebhookId).length < MAX_TRACKED_IDS) {
      stats.byWebhookId[webhookId] = (stats.byWebhookId[webhookId] ?? 0) + 1;
    }
  }

  async function webhook(req: IncomingMessage, res: ServerResponse, url: URL) {
    let behaviour;
    try {
      behaviour = parseBehaviour(url.searchParams);
    } catch (error) {
      if (error instanceof InvalidBehaviourError) {
        req.resume();
        json(
          res,
          400,
          {
            type: 'about:blank',
            title: 'Bad Request',
            status: 400,
            errors: error.issues,
          },
          'application/problem+json',
        );
        return;
      }
      throw error;
    }

    const bytes = await drain(req);
    const header = req.headers['webhook-id'];
    const webhookId = typeof header === 'string' ? header : undefined;
    stats.received += 1;
    track(webhookId);

    if (behaviour.hang) {
      stats.hung += 1;
      hung.add(res);
      res.on('close', () => hung.delete(res));
      onWebhook?.({ webhookId, bytes, outcome: 'hung' });
      return; // never answered
    }

    if (behaviour.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, behaviour.latencyMs));
    }
    if (res.destroyed) {
      return; // the caller gave up while we were "slow"
    }

    const failed = random() < behaviour.failRate;
    const status = failed ? behaviour.failStatus : behaviour.status;
    const ok = status >= 200 && status < 300;
    if (ok) stats.succeeded += 1;
    else stats.failed += 1;
    onWebhook?.({
      webhookId,
      bytes,
      outcome: ok ? 'succeeded' : 'failed',
      status,
    });

    if (status === 204) {
      res.writeHead(204).end();
    } else {
      json(
        res,
        status,
        ok
          ? { received: true }
          : { received: false, error: 'simulated failure' },
      );
    }
  }

  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const { pathname } = url;
    const method = req.method ?? 'GET';

    if (pathname === '/health' && method === 'GET') {
      return json(res, 200, { status: 'ok' });
    }
    if (pathname === '/stats' && method === 'GET') {
      return json(res, 200, stats);
    }
    if (pathname === '/stats/reset' && method === 'POST') {
      stats = fresh();
      res.writeHead(204).end();
      return;
    }
    if (pathname === HOOK_PREFIX || pathname.startsWith(`${HOOK_PREFIX}/`)) {
      if (method !== 'POST') {
        res.setHeader('allow', 'POST');
        return json(res, 405, { error: 'webhooks are sent with POST' });
      }
      return webhook(req, res, url);
    }
    return json(res, 404, { error: 'not found' });
  }

  const server: Server = createServer((req, res) => {
    route(req, res).catch(() => {
      // Nothing to tell the caller if the response is already underway.
      if (!res.headersSent) {
        json(res, 500, { error: 'mock receiver failed' });
      } else {
        res.destroy();
      }
    });
  });

  return {
    listen(port, host = '0.0.0.0') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve((server.address() as AddressInfo).port);
        });
      });
    },
    close() {
      // Idempotent: a second call, say a signal during shutdown, gets the
      // same outcome as the first instead of an error.
      closing ??= new Promise<void>((resolve, reject) => {
        // Hung requests would otherwise keep the server open forever.
        for (const res of hung) res.destroy();
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
      return closing;
    },
    stats: () => stats,
  };
}
