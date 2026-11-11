import { Module } from '@nestjs/common';
import { EndpointsController } from './endpoints.controller.js';
import { EndpointsRepository } from './endpoints.repository.js';
import { EndpointsService } from './endpoints.service.js';
import { KyselyEndpointsRepository } from './kysely-endpoints.repository.js';

@Module({
  controllers: [EndpointsController],
  providers: [
    EndpointsService,
    { provide: EndpointsRepository, useClass: KyselyEndpointsRepository },
  ],
})
export class EndpointsModule {}
