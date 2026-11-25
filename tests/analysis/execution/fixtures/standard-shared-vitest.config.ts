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
        testTimeout: 3_900_000,
    },
});
