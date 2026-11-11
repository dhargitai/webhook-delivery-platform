import { Inject, Injectable, type PipeTransform } from '@nestjs/common';
import { type ConfigType } from '@nestjs/config';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ssrfConfig } from '../config/ssrf.config.js';
import {
  type CreateEndpointBody,
  createEndpointSchema,
} from './endpoint.schemas.js';

/**
 * Validates the body of `POST /endpoints`. A class of its own, not a pipe
 * built in the decorator, because the allowed hosts come from configuration.
 */
@Injectable()
export class CreateEndpointPipe implements PipeTransform<
  unknown,
  CreateEndpointBody
> {
  private readonly pipe: ZodValidationPipe<
    ReturnType<typeof createEndpointSchema>
  >;

  constructor(@Inject(ssrfConfig.KEY) config: ConfigType<typeof ssrfConfig>) {
    this.pipe = new ZodValidationPipe(createEndpointSchema(config.allowHosts));
  }

  transform(value: unknown): CreateEndpointBody {
    return this.pipe.transform(value);
  }
}
