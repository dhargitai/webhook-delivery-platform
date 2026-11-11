import { defineConfig } from 'vitest/config';
import { workspaceAliases } from './vitest.aliases.js';

export default defineConfig({
  resolve: { alias: workspaceAliases },
  test: {
    globals: true,
    root: './',
    include: ['apps/**/*.spec.ts', 'libs/**/*.spec.ts'],
  },
});
