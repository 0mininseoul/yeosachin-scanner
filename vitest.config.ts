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
        alias: {
            '@': path.resolve(__dirname, '.'),
            // Vitest is a Node runner, not a React Server Components resolver.
            'server-only': path.resolve(__dirname, 'node_modules/server-only/empty.js'),
        },
    },
});
