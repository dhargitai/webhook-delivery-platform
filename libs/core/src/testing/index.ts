// Test support, published as `@wdp/core/testing` so apps do not reach into src.
export { createTestDatabase, type TestDatabase } from './test-database.js';
export {
  FakeEventStore,
  SequentialEventIdGenerator,
} from './fake-event-store.js';
