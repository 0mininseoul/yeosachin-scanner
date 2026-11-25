import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
    envDir: false,
    server: { host: '127.0.0.1', hmr: false },
    test: {
        include: ['tests/analysis/execution/standard-admission-result-pglite.test.ts'],
        // Threads share the parent's anonymous reporting descriptor. Forks use it for IPC.
        pool: 'threads', maxWorkers: 1, fileParallelism: false, cache: false, silent: true,
        testTimeout: 3_600_000,
    },
    resolve: {
        alias: [
            { find: /^@\/lib\/supabase\/admin$/, replacement: path.resolve('tests/analysis/execution/fixtures/private90-admin.ts') },
            { find: '@', replacement: process.cwd() },
            { find: 'server-only', replacement: path.join(process.cwd(), 'node_modules/server-only/empty.js') },
        ],
    },
});
