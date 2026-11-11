import { defineConfig } from 'vitest/config';
import { workspaceAliases } from './vitest.aliases.js';

export default defineConfig({
  resolve: { alias: workspaceAliases },
  test: {
    root: './',
    include: ['apps/**/*.int-spec.ts', 'libs/**/*.int-spec.ts'],
    globalSetup: ['./vitest.integration.setup.ts'],
    // Cold image pulls and container starts are slow.
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
