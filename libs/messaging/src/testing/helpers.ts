import { randomUUID } from 'node:crypto';

/** A namespace no other spec uses, so specs sharing one broker never meet. */
export function testingNamespace(): string {
  return `t${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

/** Retries `check` until it stops throwing, for conditions the broker settles asynchronously. */
export async function eventually(
  check: () => Promise<void> | void,
  { timeoutMs = 10_000, intervalMs = 50 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await check();
      return;
    } catch (error) {
      if (Date.now() > deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}
