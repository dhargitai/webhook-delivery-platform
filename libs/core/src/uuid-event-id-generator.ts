import { v7 } from 'uuid';
import { EventIdGenerator } from './event-store.js';

/** UUIDv7 ids are time-ordered, which keeps the events primary key index append-mostly. */
export class UuidV7EventIdGenerator extends EventIdGenerator {
  next(): string {
    return v7();
  }
}
