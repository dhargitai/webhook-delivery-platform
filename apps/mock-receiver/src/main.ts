import { Logger } from '@nestjs/common';
import { createMockReceiver } from './mock-receiver.js';

const logger = new Logger('MockReceiver');
const port = Number(process.env.PORT ?? 4000);

const receiver = createMockReceiver({
  onWebhook: (entry) => logger.log('webhook received', entry),
});
await receiver.listen(port);
logger.log('mock receiver listening', { port });

// Graceful stop on SIGTERM/SIGINT, as every service here: hung requests are
// dropped and the process exits.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    logger.log('mock receiver stopping', { signal });
    receiver.close().then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error('mock receiver failed to stop', String(error));
        process.exit(1);
      },
    );
  });
}
