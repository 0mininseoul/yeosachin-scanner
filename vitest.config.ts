import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
    test: {
        environment: 'node',
        // Bound concurrent PGlite/WASM startups to avoid resource contention.
        maxWorkers: 4,
        // Full CI runs can briefly queue PGlite/WASM startup behind the same bounded workers.
        // Keep the default test budget above that transient queue without changing test logic.
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
                    include: [
                        'lib/**/*.test.ts',
                        'app/**/*.test.ts',
                        'components/**/*.test.tsx',
                        'hooks/**/*.test.tsx',
                        'scripts/**/*.test.ts',
                        '!scripts/automatic-analysis-capacity-infra.test.ts',
                    ],
                    pool: 'forks',
                },
            },
            {
                extends: true,
                test: {
                    name: 'automatic-analysis-infra',
                    include: ['scripts/automatic-analysis-capacity-infra.test.ts'],
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
