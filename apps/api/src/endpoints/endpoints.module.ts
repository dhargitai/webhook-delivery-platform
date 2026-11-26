import { Module } from '@nestjs/common';
import { type ConfigType } from '@nestjs/config';
import { SsrfGuard } from '@wdp/core';
import { ssrfConfig } from '../config/ssrf.config.js';
import { EndpointsController } from './endpoints.controller.js';
import { EndpointsRepository } from './endpoints.repository.js';
import { EndpointsService } from './endpoints.service.js';
import { KyselyEndpointsRepository } from './kysely-endpoints.repository.js';

@Module({
  controllers: [EndpointsController],
  providers: [
    EndpointsService,
    { provide: EndpointsRepository, useClass: KyselyEndpointsRepository },
    {
      // The same allowlist as the URL rules, so the dev mock receiver, which
      // sits on a private address, can still be registered.
      provide: SsrfGuard,
      inject: [ssrfConfig.KEY],
      useFactory: (config: ConfigType<typeof ssrfConfig>) =>
        new SsrfGuard({ allowHosts: config.allowHosts }),
    },
  ],
})
export class EndpointsModule {}
