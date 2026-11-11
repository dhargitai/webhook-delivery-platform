import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { IdempotentIngest } from '@wdp/core';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import {
  type CreateEventBody,
  createEventSchema,
} from './create-event.schema.js';
import { IdempotencyKey } from './idempotency-key.decorator.js';
import { IngestRateLimitGuard } from './ingest-rate-limit.guard.js';

@Controller('events')
@UseGuards(IngestRateLimitGuard)
export class EventsController {
  constructor(private readonly ingest: IdempotentIngest) {}

  /** 202: the event is durably stored and will be published; delivery is asynchronous. */
  @Post()
  @HttpCode(202)
  async create(
    @CurrentTenant() tenantId: string,
    @IdempotencyKey() idempotencyKey: string | null,
    @Body(new ZodValidationPipe(createEventSchema)) body: CreateEventBody,
  ): Promise<{ event_id: string }> {
    const { eventId } = await this.ingest.accept(
      tenantId,
      idempotencyKey,
      body,
    );
    return { event_id: eventId };
  }
}
