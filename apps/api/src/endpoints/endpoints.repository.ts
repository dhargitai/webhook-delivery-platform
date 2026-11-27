import type { SealedSecret } from '@wdp/core';

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

/** How a secret rotation went. */
export type SecretRotation =
  /** The new secret is current; the old one signs until `previousExpiresAt`. */
  | { kind: 'rotated'; previousExpiresAt: Date }
  /** An earlier rotation's overlap lasts until `until`; nothing changed. */
  | { kind: 'in_progress'; until: Date }
  | { kind: 'not_found' };

/**
 * Every method takes the tenant and only ever sees that tenant's rows, so an
 * id from another tenant behaves exactly like an id that does not exist.
 */
export abstract class EndpointsRepository {
  /**
   * Stores the endpoint under `id`, chosen by the caller because the sealed
   * secret is bound to it. The secret is stored sealed only, and never read
   * back through this contract: the returned `Endpoint` has no secret.
   */
  abstract create(
    tenantId: string,
    id: string,
    input: NewEndpoint,
    signingSecret: SealedSecret,
  ): Promise<Endpoint>;

  /**
   * Makes `next` the current secret and keeps the current one as the previous
   * secret for `overlapSeconds`, by the database clock. Refused while an
   * earlier rotation's previous secret still signs, so no secret a receiver
   * may rely on is ever dropped. Atomic: concurrent rotations cannot both win.
   */
  abstract rotateSecret(
    tenantId: string,
    id: string,
    next: SealedSecret,
    overlapSeconds: number,
  ): Promise<SecretRotation>;

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
