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
 * Order matters: the specific `@wdp/core/testing` entry must come before
 * `@wdp/core`, or the shorter alias would swallow it.
 */
export const workspaceAliases: Record<string, string> = {
  '@wdp/core/testing': fromRoot('./libs/core/src/testing/index.ts'),
  ...Object.fromEntries(
    libs.map((lib) => [`@wdp/${lib}`, fromRoot(`./libs/${lib}/src/index.ts`)]),
  ),
};
