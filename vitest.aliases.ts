import { fileURLToPath } from 'node:url';

const libs = ['domain', 'core', 'messaging', 'observability'] as const;

/**
 * Resolves every `@wdp/*` import to the library's sources in tests.
 *
 * Not derived from the tsconfig `paths`: each lib's build tsconfig overrides
 * them with `{}`, so a source file inside a lib would resolve a sibling lib to
 * its compiled `dist` while a spec file resolves it to `src`. Two module
 * copies then exist and `instanceof` checks across them fail.
 */
export const workspaceAliases = Object.fromEntries(
  libs.map((lib) => [
    `@wdp/${lib}`,
    fileURLToPath(new URL(`./libs/${lib}/src/index.ts`, import.meta.url)),
  ]),
);
