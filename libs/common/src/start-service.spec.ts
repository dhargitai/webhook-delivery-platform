import { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ServiceHost, startService } from './start-service.js';

/** Stands in for `process`: records exit codes instead of exiting. */
class FakeHost extends EventEmitter implements ServiceHost {
  readonly exitCodes: number[] = [];

  exit(code: number): void {
    this.exitCodes.push(code);
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('startService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const fatalLog = () =>
    vi.spyOn(Logger.prototype, 'fatal').mockImplementation(() => undefined);

  it('logs a failed boot as one fatal line with the stack, then exits 1', async () => {
    const fatal = fatalLog();
    const host = new FakeHost();
    const error = new Error('mongo is unreachable');

    startService(() => Promise.reject(error), host);

    await vi.waitFor(() => expect(host.exitCodes).toEqual([1]));
    expect(fatal).toHaveBeenCalledTimes(1);
    expect(fatal).toHaveBeenCalledWith('service failed to start', error.stack);
  });

  it('logs a rejection that is not an Error', async () => {
    const fatal = fatalLog();
    const host = new FakeHost();

    startService(() => Promise.reject('no config'), host);

    await vi.waitFor(() => expect(host.exitCodes).toEqual([1]));
    expect(fatal).toHaveBeenCalledWith('service failed to start', 'no config');
  });

  it('neither logs nor exits when the boot succeeds', async () => {
    const fatal = fatalLog();
    const host = new FakeHost();

    startService(() => Promise.resolve(), host);
    await flush();

    expect(fatal).not.toHaveBeenCalled();
    expect(host.exitCodes).toEqual([]);
  });

  it('logs an unhandled rejection after boot as fatal, then exits 1', async () => {
    const fatal = fatalLog();
    const host = new FakeHost();
    const error = new Error('lost a promise');
    startService(() => Promise.resolve(), host);
    await flush();

    host.emit('unhandledRejection', error);

    expect(fatal).toHaveBeenCalledWith(
      'unhandled promise rejection',
      error.stack,
    );
    expect(host.exitCodes).toEqual([1]);
  });
});
