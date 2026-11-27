import type { SealedSecret, SecretOpener } from './secret-cipher.js';

/** PRD: workers cache decrypted secrets for 60 s. */
const DEFAULT_TTL_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 10_000;

export interface CachedSecretOpenerOptions {
  ttlMs?: number;
  /** Bounds memory however many endpoints a worker sees; the oldest entry goes first. */
  maxEntries?: number;
  now?: () => number;
}

interface Entry {
  secret: Promise<string>;
  storedAt: number;
}

/**
 * Keeps opened secrets in memory for a short while, so a busy endpoint does
 * not unwrap its data key on every delivery (a network call once a KMS holds
 * the KEK). Keyed by the AAD (the endpoint) and the seal's IV, which is unique
 * per seal: a rotated secret is a new entry at once, never a stale hit.
 */
export class CachedSecretOpener implements SecretOpener {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  // Insertion order is age order: entries are never refreshed in place.
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly inner: SecretOpener,
    {
      ttlMs = DEFAULT_TTL_MS,
      maxEntries = DEFAULT_MAX_ENTRIES,
      now = Date.now,
    }: CachedSecretOpenerOptions = {},
  ) {
    if (!Number.isInteger(ttlMs) || ttlMs < 1) {
      throw new RangeError(`ttlMs must be a positive integer, got ${ttlMs}`);
    }
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError(
        `maxEntries must be a positive integer, got ${maxEntries}`,
      );
    }
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
  }

  open(sealed: SealedSecret, aad: string): Promise<string> {
    const key = `${aad}\u0000${sealed.iv.toString('hex')}`;
    const now = this.now();
    const entry = this.entries.get(key);
    if (entry !== undefined && now < entry.storedAt + this.ttlMs) {
      return entry.secret;
    }
    this.entries.delete(key);

    // The promise is cached, not its value, so concurrent opens of one
    // secret share a single unwrap. A failure is forgotten at once, so the
    // next delivery tries again instead of failing for the whole TTL.
    const secret = this.inner.open(sealed, aad);
    secret.catch(() => {
      if (this.entries.get(key)?.secret === secret) {
        this.entries.delete(key);
      }
    });
    this.store(key, { secret, storedAt: now });
    return secret;
  }

  /**
   * Evicts oldest first. Entries are in age order, so expired ones always go
   * before live ones; an expired entry left behind is only memory, bounded by
   * `maxEntries`, and is replaced on its next open.
   */
  private store(key: string, entry: Entry): void {
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
    this.entries.set(key, entry);
  }
}
