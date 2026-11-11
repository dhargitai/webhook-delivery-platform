export abstract class SubscriptionLookup {
  /**
   * The endpoints of a tenant that are active and subscribed to an event type,
   * in the order they were registered. Never another tenant's endpoints.
   */
  abstract findActiveEndpointIds(
    tenantId: string,
    eventType: string,
  ): Promise<string[]>;
}
