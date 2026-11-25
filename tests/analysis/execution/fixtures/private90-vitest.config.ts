import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
    server: { host: '127.0.0.1', hmr: false },
    test: {
        include: ['tests/analysis/execution/standard-admission-result-pglite.test.ts'],
        // Threads share the parent's anonymous reporting descriptor. Forks use it for IPC.
        pool: 'threads', maxWorkers: 1, fileParallelism: false, cache: false, silent: true,
        testTimeout: 3_600_000,
    },
    resolve: {
        alias: {
            '@': process.cwd(),
            'server-only': path.join(process.cwd(), 'node_modules/server-only/empty.js'),
        },
    },
});
