import type { NestExpressApplication } from '@nestjs/platform-express';

/** Request body limit: the PRD caps an event payload at 64 KB. */
export const MAX_BODY_SIZE = '64kb';

/**
 * Global setup shared by main.ts and the e2e specs, so tests run the app
 * exactly as production does.
 */
export function configureApp(app: NestExpressApplication): void {
  app.setGlobalPrefix('v1');
  // Express defaults to 100 kb; replace it with the PRD limit.
  app.useBodyParser('json', { limit: MAX_BODY_SIZE });
}
