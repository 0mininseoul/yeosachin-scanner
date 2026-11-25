import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    envDir: false,
    server: { host: '127.0.0.1', hmr: false },
    resolve: {
        alias: {
            '@': process.cwd(),
            'server-only': path.join(process.cwd(), 'node_modules/server-only/empty.js'),
        }
    },
    test: {
        include: ['tests/analysis/execution/standard-shared-capacity.integration.ts'],
        pool: 'threads', maxWorkers: 1, fileParallelism: false, cache: false,
        // Let slow runs finish and emit per-owner evidence before asserting the one-hour target.
        testTimeout: 4 * 60 * 60 * 1000,
    },
});
