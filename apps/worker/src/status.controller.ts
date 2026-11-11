import { Controller, Get } from '@nestjs/common';

/**
 * Liveness only: it says the process is up and serving. It probes no
 * dependency, because the worker has none yet; readiness checks belong to the
 * tasks that add the broker and the attempt log.
 */
@Controller('status')
export class StatusController {
  @Get()
  status(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
