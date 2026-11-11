export type EndpointStatus = 'active' | 'disabled';

export interface Endpoint {
  id: string;
  tenantId: string;
  url: string;
  description: string | null;
  status: EndpointStatus;
  createdAt: Date;
}

export interface NewEndpoint {
  url: string;
  description: string | null;
}

/**
 * Every method takes the tenant and only ever sees that tenant's rows, so an
 * id from another tenant behaves exactly like an id that does not exist.
 */
export abstract class EndpointsRepository {
  abstract create(tenantId: string, input: NewEndpoint): Promise<Endpoint>;

  /** In creation order. */
  abstract list(tenantId: string): Promise<Endpoint[]>;

  abstract find(tenantId: string, id: string): Promise<Endpoint | null>;

  /** Also removes the endpoint's subscriptions. False when there was nothing to delete. */
  abstract delete(tenantId: string, id: string): Promise<boolean>;

  /**
   * Atomically swaps the endpoint's subscription set for `eventTypes`, which
   * must not contain duplicates. False when the endpoint does not exist.
   */
  abstract replaceSubscriptions(
    tenantId: string,
    id: string,
    eventTypes: string[],
  ): Promise<boolean>;

  /** Sorted event types, or null when the endpoint does not exist. */
  abstract listSubscriptions(
    tenantId: string,
    id: string,
  ): Promise<string[] | null>;
}
