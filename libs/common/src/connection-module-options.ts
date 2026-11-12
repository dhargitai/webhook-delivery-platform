import type { InjectionToken } from '@nestjs/common';

/**
 * Where a connection's URL comes from: the providers to inject (an app's
 * config namespace, typically) and how to read the URL from them.
 */
export interface ConnectionModuleOptions<Deps extends unknown[]> {
  inject: InjectionToken[];
  url: (...deps: Deps) => string;
}
