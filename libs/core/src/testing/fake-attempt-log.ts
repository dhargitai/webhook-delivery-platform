import { type AttemptRecord, AttemptLog } from '../delivery/attempt-log.js';

/** An in-memory attempt log that keeps what it was given, for assertions. */
export class FakeAttemptLog extends AttemptLog {
  readonly records: AttemptRecord[] = [];
  /** Set to make the next writes fail, like a database that is down. */
  failWith?: Error;

  async record(record: AttemptRecord): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.records.push(record);
  }
}
