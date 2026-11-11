import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ApiKeyGuard } from './api-key.guard.js';
import { ApiKeyRepository } from './api-key.repository.js';
import { KyselyApiKeyRepository } from './kysely-api-key.repository.js';

@Module({
  providers: [
    { provide: ApiKeyRepository, useClass: KyselyApiKeyRepository },
    // Registered through APP_GUARD so it is global and can inject the repository.
    { provide: APP_GUARD, useClass: ApiKeyGuard },
  ],
})
export class AuthModule {}
