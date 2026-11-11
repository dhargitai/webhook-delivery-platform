import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import {
  type CreateEndpointBody,
  type ReplaceSubscriptionsBody,
  replaceSubscriptionsSchema,
} from './endpoint.schemas.js';
import {
  type CreatedEndpointResponse,
  type EndpointResponse,
  toCreatedEndpointResponse,
  toEndpointResponse,
} from './endpoint.response.js';
import { CreateEndpointPipe } from './create-endpoint.pipe.js';
import { EndpointsService } from './endpoints.service.js';

interface SubscriptionsResponse {
  event_types: string[];
}

@Controller('endpoints')
export class EndpointsController {
  constructor(private readonly endpoints: EndpointsService) {}

  @Post()
  async create(
    @CurrentTenant() tenantId: string,
    @Body(CreateEndpointPipe) body: CreateEndpointBody,
  ): Promise<CreatedEndpointResponse> {
    return toCreatedEndpointResponse(
      await this.endpoints.create(tenantId, body),
    );
  }

  @Get()
  async list(
    @CurrentTenant() tenantId: string,
  ): Promise<{ data: EndpointResponse[] }> {
    const endpoints = await this.endpoints.list(tenantId);
    return { data: endpoints.map(toEndpointResponse) };
  }

  @Get(':id')
  async get(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<EndpointResponse> {
    return toEndpointResponse(await this.endpoints.get(tenantId, id));
  }

  @Delete(':id')
  @HttpCode(204)
  async delete(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.endpoints.delete(tenantId, id);
  }

  /** Replaces the whole set, so repeating a request changes nothing. */
  @Put(':id/subscriptions')
  async replaceSubscriptions(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(replaceSubscriptionsSchema))
    body: ReplaceSubscriptionsBody,
  ): Promise<SubscriptionsResponse> {
    const eventTypes = await this.endpoints.replaceSubscriptions(
      tenantId,
      id,
      body.event_types,
    );
    return { event_types: eventTypes };
  }

  @Get(':id/subscriptions')
  async listSubscriptions(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SubscriptionsResponse> {
    return {
      event_types: await this.endpoints.listSubscriptions(tenantId, id),
    };
  }
}
