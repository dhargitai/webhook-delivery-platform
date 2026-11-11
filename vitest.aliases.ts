import { fileURLToPath } from 'node:url';

const libs = ['domain', 'core', 'messaging', 'observability'] as const;

const fromRoot = (path: string) =>
  fileURLToPath(new URL(path, import.meta.url));

/**
 * Resolves every `@wdp/*` import to the library's sources in tests.
 *
 * Not derived from the tsconfig `paths`: each lib's build tsconfig overrides
 * them with `{}`, so a source file inside a lib would resolve a sibling lib to
 * its compiled `dist` while a spec file resolves it to `src`. Two module
 * copies then exist and `instanceof` checks across them fail.
 *
 * Order matters: the specific `/testing` entries must come before their
 * library's own alias, or the shorter alias would swallow them.
 */
export const workspaceAliases: Record<string, string> = {
  '@wdp/core/testing': fromRoot('./libs/core/src/testing/index.ts'),
  '@wdp/messaging/testing': fromRoot('./libs/messaging/src/testing/index.ts'),
  ...Object.fromEntries(
    libs.map((lib) => [`@wdp/${lib}`, fromRoot(`./libs/${lib}/src/index.ts`)]),
  ),
};
