import type { Database, LaneRouter } from '@wdp/core';
import type { Kysely } from 'kysely';
import type { Collection, Document } from 'mongodb';
import type { LoadApiClient } from './api-client.js';
import { readFirstAttempts } from './first-attempts.js';
import { type OpenLoopResult, type PacerClock, runOpenLoop } from './pacer.js';
import {
  buildReport,
  type ExpectedDelivery,
  type FirstAttempt,
  type LoadReport,
} from './report.js';
import {
  eventTypeFor,
  planScenario,
  type ScenarioOptions,
} from './scenario.js';
import {
  type PreparedEndpoint,
  type PreparedScenario,
  setUpScenario,
} from './setup.js';

const DRAIN_POLL_MS = 1_000;

export interface LoadTestDeps {
  db: Kysely<Database>;
  /** The worker's attempt log. */
  attempts: Collection<Document>;
  api: LoadApiClient;
  /** With the dispatcher's lane count, to tell which victims share the hanging lane. */
  lanes: LaneRouter;
  clock: PacerClock;
}

export interface LoadTestOptions extends ScenarioOptions {
  durationSeconds: number;
  /** How long to wait after the load for the last first attempts. */
  drainSeconds: number;
}

/**
 * One isolation run: set up fresh tenants, send every tenant's load at once
 * for the duration, wait until each accepted victim delivery has a first
 * attempt (or the drain time is up), then judge the run.
 */
export async function runLoadTest(
  deps: LoadTestDeps,
  options: LoadTestOptions,
): Promise<LoadReport> {
  const prepared = await setUpScenario(deps, planScenario(options));
  try {
    return await loadAndJudge(deps, options, prepared);
  } finally {
    await tearDown(deps.api, prepared);
  }
}

/**
 * Deletes the run's endpoints. The noisy tenant's deliveries would otherwise
 * stay re-parked forever while its circuit is open (a deferral uses no
 * attempt), loading every run after this one; once their endpoint is gone the
 * worker skips and acks them.
 */
async function tearDown(
  api: LoadApiClient,
  prepared: PreparedScenario,
): Promise<void> {
  for (const tenant of [prepared.noisy, ...prepared.victims]) {
    for (const endpoint of tenant.endpoints) {
      await api.deleteEndpoint(tenant.apiKey, endpoint.id);
    }
  }
}

async function loadAndJudge(
  deps: LoadTestDeps,
  options: LoadTestOptions,
  prepared: PreparedScenario,
): Promise<LoadReport> {
  const { api, clock } = deps;

  const expected: ExpectedDelivery[] = [];
  const ingest = {
    accepted: 0,
    noisyRateLimited: 0,
    victimRateLimited: 0,
    failed: 0,
  };
  const startedAt = new Date();

  const victimRuns = prepared.victims.map((tenant) => {
    const endpointsByType = groupByType(tenant.endpoints);
    return runOpenLoop({
      ratePerSecond: tenant.plan.ratePerSecond,
      durationSeconds: options.durationSeconds,
      clock,
      send: async (index) => {
        const type = eventTypeFor(tenant.plan, index);
        const result = await api.sendEvent(tenant.apiKey, type);
        if (result.kind === 'accepted') {
          ingest.accepted += 1;
          for (const endpoint of endpointsByType.get(type) ?? []) {
            expected.push({
              eventId: result.eventId,
              endpointId: endpoint.id,
              onHangingLane: endpoint.onHangingLane,
            });
          }
        } else if (result.kind === 'rate_limited') {
          ingest.victimRateLimited += 1;
        } else {
          ingest.failed += 1;
        }
      },
    });
  });

  // Its deliveries go to the hanging endpoint and are never expected to
  // succeed, so only its ingest outcome is counted. A failed noisy send says
  // nothing about the victims and is left out.
  const { noisy } = prepared;
  const noisyType = eventTypeFor(noisy.plan, 0);
  const noisyRun: Promise<OpenLoopResult | null> =
    noisy.plan.ratePerSecond === 0
      ? Promise.resolve(null)
      : runOpenLoop({
          ratePerSecond: noisy.plan.ratePerSecond,
          durationSeconds: options.durationSeconds,
          clock,
          send: async () => {
            const result = await api.sendEvent(noisy.apiKey, noisyType);
            if (result.kind === 'accepted') ingest.accepted += 1;
            else if (result.kind === 'rate_limited') {
              ingest.noisyRateLimited += 1;
            }
          },
        });

  const runs = await Promise.all([...victimRuns, noisyRun]);
  const generatorMaxLagMs = Math.max(0, ...runs.map((r) => r?.maxLagMs ?? 0));

  const firstAttempts = await drain(deps, {
    tenantIds: prepared.victims.map((tenant) => tenant.tenantId),
    since: startedAt,
    expected,
    deadline: clock.now() + options.drainSeconds * 1_000,
  });

  return buildReport({
    run: {
      label: options.label,
      startedAt,
      durationSeconds: options.durationSeconds,
    },
    ingest,
    generatorMaxLagMs: Math.round(generatorMaxLagMs),
    expected,
    firstAttempts,
  });
}

/** Polls the attempt log until every expected delivery is there, or the deadline passes. */
async function drain(
  { attempts, clock }: LoadTestDeps,
  query: {
    tenantIds: string[];
    since: Date;
    expected: readonly ExpectedDelivery[];
    deadline: number;
  },
): Promise<FirstAttempt[]> {
  const wanted = new Set(
    query.expected.map((d) => `${d.eventId}|${d.endpointId}`),
  );
  for (;;) {
    const found = await readFirstAttempts(attempts, query);
    const seen = new Set(
      found
        .map((a) => `${a.eventId}|${a.endpointId}`)
        .filter((k) => wanted.has(k)),
    );
    if (seen.size === wanted.size || clock.now() >= query.deadline) {
      return found;
    }
    await clock.sleep(DRAIN_POLL_MS);
  }
}

function groupByType(
  endpoints: readonly PreparedEndpoint[],
): Map<string, PreparedEndpoint[]> {
  const byType = new Map<string, PreparedEndpoint[]>();
  for (const endpoint of endpoints) {
    for (const type of endpoint.eventTypes) {
      byType.set(type, [...(byType.get(type) ?? []), endpoint]);
    }
  }
  return byType;
}
