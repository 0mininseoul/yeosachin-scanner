import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
    test: {
        environment: 'node',
        // Bound concurrent PGlite/WASM startups to avoid resource contention.
        maxWorkers: 4,
        // Manual multi-file runs can queue PGlite/WASM startup behind these workers.
        testTimeout: 15_000,
        // The infrastructure contract suite intentionally runs synchronous, bounded child
        // commands (fake gcloud/curl and git fixtures). A fork worker can leave Vitest's
        // onTaskUpdate RPC pending after the suite finishes, which is observable as a false
        // failure once the file runs for roughly the 60s RPC window. Keep that harness in a
        // dedicated thread project; its test isolation and child-process deadlines remain
        // unchanged.
        projects: [
            {
                extends: true,
                test: {
                    name: 'default',
                    include: ['tests/**/*.test.{ts,tsx}'],
                    exclude: ['tests/infra/tools/automatic-analysis-capacity-infra.test.ts'],
                    pool: 'forks',
                },
            },
            {
                extends: true,
                test: {
                    name: 'automatic-analysis-infra',
                    include: ['tests/infra/tools/automatic-analysis-capacity-infra.test.ts'],
                    pool: 'threads',
                    // Each contract invokes bounded fake gcloud/curl/git children serially;
                    // retain a per-child 30s deadline while allowing one full assertion to
                    // complete when the rest of the suite is consuming CPU.
                    testTimeout: 60_000,
                },
            },
        ],
    },
    resolve: {
        alias: {
            '@': path.resolve(__dirname, '.'),
            // Vitest is a Node runner, not a React Server Components resolver.
            'server-only': path.resolve(__dirname, 'node_modules/server-only/empty.js'),
        },
    },
});
