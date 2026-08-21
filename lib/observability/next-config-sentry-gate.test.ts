import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ withSentryConfig: vi.fn((config: object) => ({
    ...config,
    compiler: { runAfterProductionCompile: () => undefined },
})) }));

vi.mock('@sentry/nextjs', () => ({ withSentryConfig: mocks.withSentryConfig }));

describe('Next config Sentry build gate', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.resetAllMocks();
        vi.stubEnv('SENTRY_AUTH_TOKEN', 'present-but-safe-test-token');
        vi.stubEnv('SENTRY_SOURCEMAPS_UPLOAD', 'false');
        vi.stubEnv('CI', 'false');
    });
    afterEach(() => vi.unstubAllEnvs());

    it('exports plain Next config and never invokes withSentryConfig when the upload gate is off', async () => {
        const config = (await import('../../next.config')).default;
        expect(mocks.withSentryConfig).not.toHaveBeenCalled();
        expect(config.compiler?.runAfterProductionCompile).toBeUndefined();
    });

    it('uses withSentryConfig only when CI, upload flag, and token are all present', async () => {
        vi.stubEnv('CI', 'true');
        vi.stubEnv('SENTRY_SOURCEMAPS_UPLOAD', 'true');
        const config = (await import('../../next.config')).default;
        expect(mocks.withSentryConfig).toHaveBeenCalledOnce();
        expect(config.compiler?.runAfterProductionCompile).toBeTypeOf('function');
    });

    it('traces the complete Cloud Tasks build for every Vercel enqueue route', async () => {
        const config = (await import('../../next.config')).default;
        const includes = config.outputFileTracingIncludes ?? {};
        const taskBuild = './node_modules/@google-cloud/tasks/build/**/*';
        for (const route of [
            '/api/analysis/start',
            '/api/analysis/step',
            '/api/analysis/preflight',
            '/api/analysis/preflight/[preflightId]/entitle',
            '/api/analysis/betatest/preflight/[preflightId]/admit',
            '/api/analysis/v2/recover',
            '/api/analysis/v2/worker',
        ]) {
            expect(includes[route]).toContain(taskBuild);
        }
    });
});
