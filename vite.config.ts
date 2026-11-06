import { defineConfig } from 'vitest/config';

export default defineConfig({
  // planegcs locates its .wasm via import.meta.url; pre-bundling would break that.
  optimizeDeps: {
    exclude: ['@salusoft89/planegcs'],
  },
  build: {
    target: 'es2022',
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
