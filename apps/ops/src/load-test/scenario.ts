import { DEFAULT_ENDPOINT_LIMITER } from '@wdp/core';

/**
 * The most a victim endpoint is offered, per second: three quarters of the
 * per-endpoint token bucket (20/s). A victim must never be rate-limited by its
 * own traffic, or its parked deliveries would be blamed on the noisy tenant.
 */
const SPREAD_RATE = DEFAULT_ENDPOINT_LIMITER.ratePerSecond * 0.75;
// A healthy receiver still takes some time to answer.
const HEALTHY_QUERY = 'latency=20';
const NOISY_EVENT_TYPE = 'noisy.flood';
const LABEL = /^[a-z0-9][a-z0-9-]*$/;

export interface ScenarioOptions {
  /** Names the run's tenants, so every run starts with new endpoints and breakers. */
  label: string;
  /** Well-behaved tenants, whose latency is measured. */
  tenants: number;
  /** Events per second each victim sends; keep it under the 100/s ingest limit. */
  ratePerTenant: number;
  /** Endpoints subscribed to each event type. */
  fanout: number;
  /** Events per second the noisy tenant tries to send; most get `429`. */
  noisyRate: number;
  /** The mock receiver, as the worker reaches it. */
  receiverBaseUrl: string;
}

export interface PlannedEndpoint {
  url: string;
  eventTypes: string[];
  /** Deliveries per second the run sends it. */
  offeredRate: number;
}

export interface PlannedTenant {
  name: string;
  ratePerSecond: number;
  eventTypes: string[];
  endpoints: PlannedEndpoint[];
}

export interface Scenario {
  victims: PlannedTenant[];
  /** Floods the ingest limit, and every event it gets in goes to a hanging endpoint. */
  noisy: PlannedTenant;
}

/**
 * The tenants, event types and endpoints of a run. A victim's events
 * round-robin over its types, and each type has `fanout` endpoints of its
 * own, so every victim endpoint receives `rate / types` per second, below the
 * token bucket. The noisy tenant's one endpoint hangs, so its deliveries hit
 * the concurrency cap, the token bucket and the circuit breaker together.
 */
export function planScenario(options: ScenarioOptions): Scenario {
  validate(options);
  const base = options.receiverBaseUrl.replace(/\/+$/, '');
  const typeCount = Math.ceil(options.ratePerTenant / SPREAD_RATE);
  const offeredRate = options.ratePerTenant / typeCount;

  const victims = Array.from({ length: options.tenants }, (_, n) => {
    const eventTypes = Array.from(
      { length: typeCount },
      (_, k) => `load.t${k}`,
    );
    return {
      name: `load-${options.label}-v${n + 1}`,
      ratePerSecond: options.ratePerTenant,
      eventTypes,
      endpoints: eventTypes.flatMap((type) =>
        Array.from({ length: options.fanout }, () => ({
          url: `${base}/hook?${HEALTHY_QUERY}`,
          eventTypes: [type],
          offeredRate,
        })),
      ),
    };
  });

  return {
    victims,
    noisy: {
      name: `load-${options.label}-noisy`,
      ratePerSecond: options.noisyRate,
      eventTypes: [NOISY_EVENT_TYPE],
      endpoints: [
        {
          url: `${base}/hook?hang=1`,
          eventTypes: [NOISY_EVENT_TYPE],
          offeredRate: options.noisyRate,
        },
      ],
    },
  };
}

/** The type of a tenant's `index`th event. */
export function eventTypeFor(tenant: PlannedTenant, index: number): string {
  const type = tenant.eventTypes[index % tenant.eventTypes.length];
  if (type === undefined) {
    throw new Error(`tenant "${tenant.name}" has no event types`);
  }
  return type;
}

function validate(options: ScenarioOptions): void {
  const positive = ['tenants', 'ratePerTenant', 'fanout'] as const;
  for (const name of positive) {
    const value = options[name];
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive integer, got ${value}`);
    }
  }
  if (!Number.isInteger(options.noisyRate) || options.noisyRate < 0) {
    throw new Error(
      `noisyRate must be zero or a positive integer, got ${options.noisyRate}`,
    );
  }
  if (!LABEL.test(options.label)) {
    throw new Error(
      `label must be lower-case letters, digits and dashes, got "${options.label}"`,
    );
  }
}
