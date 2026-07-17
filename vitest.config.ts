import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
    test: {
        environment: 'node',
        include: ['lib/**/*.test.ts', 'scripts/**/*.test.ts'],
        // Bound concurrent PGlite/WASM startups to avoid resource contention.
        maxWorkers: 4,
    },
    resolve: {
        alias: { '@': path.resolve(__dirname, '.') },
    },
});
