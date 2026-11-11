export interface ApiKeyRecord {
  tenantId: string;
  /** SHA-256 hex of the full key. */
  keyHash: string;
  revokedAt: Date | null;
}

/** Looks API keys up by their public prefix. */
export abstract class ApiKeyRepository {
  abstract findByPrefix(prefix: string): Promise<ApiKeyRecord | null>;
}
