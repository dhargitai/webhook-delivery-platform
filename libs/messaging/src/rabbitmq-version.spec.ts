import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const read = (file: string) => readFileSync(resolve(root, file), 'utf8');

/**
 * The tag of the RabbitMQ image, e.g. `4.4-management`. Anchored to an image
 * reference (`image: rabbitmq:...` or a quoted `'rabbitmq:...'`), because the
 * Compose file also has a `rabbitmq:5672` host name in a connection URL.
 */
function rabbitTag(source: string, file: string): string {
  const match = /(?:image:\s*|')rabbitmq:([\w.-]+)/.exec(source);
  if (!match?.[1]) {
    throw new Error(`no rabbitmq image in ${file}`);
  }
  return match[1];
}

describe('the pinned RabbitMQ version', () => {
  const compose = rabbitTag(read('docker-compose.yml'), 'docker-compose.yml');
  const tests = rabbitTag(
    read('vitest.integration.setup.ts'),
    'vitest.integration.setup.ts',
  );
  // The retry design relies on 4.4 semantics: a nack with requeue does not
  // count toward the delivery limit, a reject with requeue does.
  const minor = (tag: string) => /^(\d+\.\d+)(?:\.\d+)?(?:-|$)/.exec(tag)?.[1];

  it('is a fixed major.minor in Compose, not a floating tag', () => {
    expect(minor(compose)).toBe('4.4');
  });

  it('is a fixed major.minor in the integration tests, not a floating tag', () => {
    expect(minor(tests)).toBe('4.4');
  });

  it('is the same in Compose and in the integration tests', () => {
    expect(minor(compose)).toBe(minor(tests));
  });
});
