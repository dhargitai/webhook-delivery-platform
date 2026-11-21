import { Logger } from '@nestjs/common';

/** The part of `process` a service's start-up needs. */
export interface ServiceHost {
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown;
  exit(code: number): void;
}

/**
 * Runs a service's `bootstrap` from its `main.ts`, so that a failed start
 * shows as one fatal log line instead of a raw stack trace from Node.
 *
 * Nest already reports errors while it creates the app, but not those of the
 * boot hooks `listen()` or `init()` run afterwards (a database that cannot be
 * reached, say). The exit is explicit: the connections opened before the
 * failure would keep the process alive, and a non-zero code is what makes
 * Compose's `restart: on-failure` try again.
 *
 * Returns nothing, so the caller has no promise to await: a top-level
 * `await` would turn a rejection into an uncaught exception printed by Node.
 */
export function startService(
  bootstrap: () => Promise<void>,
  host: ServiceHost = process,
): void {
  const logger = new Logger('Bootstrap');
  const fail = (message: string) => (reason: unknown) => {
    logger.fatal(
      message,
      reason instanceof Error ? reason.stack : String(reason),
    );
    host.exit(1);
  };
  // A promise nobody handled is a bug whose state is unknown afterwards.
  host.on('unhandledRejection', fail('unhandled promise rejection'));
  bootstrap().catch(fail('service failed to start'));
}
