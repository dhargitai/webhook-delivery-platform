import type { Database, LaneRouter } from '@wdp/core';
import type { Kysely } from 'kysely';
import { seedTenant } from '../seed-tenant.js';
import type { LoadApiClient } from './api-client.js';
import type { PlannedTenant, Scenario } from './scenario.js';

export interface PreparedEndpoint {
  id: string;
  eventTypes: string[];
  /** Whether it shares a fresh lane with the noisy tenant's hanging endpoint. */
  onHangingLane: boolean;
}

export interface PreparedTenant {
  plan: PlannedTenant;
  tenantId: string;
  apiKey: string;
  endpoints: PreparedEndpoint[];
}

export interface PreparedScenario {
  victims: PreparedTenant[];
  noisy: PreparedTenant;
}

export interface SetUpDeps {
  db: Kysely<Database>;
  api: LoadApiClient;
  lanes: LaneRouter;
}

/**
 * Creates the scenario's tenants (directly in Postgres, as the seed command
 * does) and their endpoints and subscriptions (through the API, which seals
 * each signing secret as in production).
 */
export async function setUpScenario(
  { db, api, lanes }: SetUpDeps,
  scenario: Scenario,
): Promise<PreparedScenario> {
  // The noisy tenant first: its endpoint's lane decides which victims share it.
  const noisy = await prepareTenant(db, api, scenario.noisy);
  const hangingEndpoint = noisy.endpoints[0];
  if (hangingEndpoint === undefined) {
    throw new Error('the noisy tenant has no endpoint');
  }
  const hangingLane = lanes.lane(hangingEndpoint.id);

  const victims: PreparedTenant[] = [];
  for (const plan of scenario.victims) {
    const tenant = await prepareTenant(db, api, plan);
    for (const endpoint of tenant.endpoints) {
      endpoint.onHangingLane = lanes.lane(endpoint.id) === hangingLane;
    }
    victims.push(tenant);
  }
  return { victims, noisy };
}

async function prepareTenant(
  db: Kysely<Database>,
  api: LoadApiClient,
  plan: PlannedTenant,
): Promise<PreparedTenant> {
  const { tenantId, apiKey } = await seedTenant(db, { tenantName: plan.name });
  const endpoints: PreparedEndpoint[] = [];
  for (const endpoint of plan.endpoints) {
    const id = await api.createEndpoint(apiKey, endpoint.url);
    await api.subscribe(apiKey, id, endpoint.eventTypes);
    endpoints.push({
      id,
      eventTypes: endpoint.eventTypes,
      onHangingLane: false,
    });
  }
  return { plan, tenantId, apiKey, endpoints };
}
