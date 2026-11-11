import { defineConfig } from 'vitest/config';
import { workspaceAliases } from './vitest.aliases.js';

export default defineConfig({
  resolve: { alias: workspaceAliases },
  test: {
    globals: true,
    root: './',
    include: ['apps/**/*.e2e-spec.ts'],
    // The same containers as the integration tests: e2e runs the real app.
    globalSetup: ['./vitest.integration.setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
