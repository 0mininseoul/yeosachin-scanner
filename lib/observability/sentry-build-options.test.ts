import { describe, expect, it } from 'vitest';
import { sentryBuildOptions } from './sentry-build-options';

describe('Sentry build source-map upload gate', () => {
    it('does not pass a locally present auth token outside the explicit CI upload gate', () => {
        const options = sentryBuildOptions({
            SENTRY_AUTH_TOKEN: 'local-token-must-not-upload',
            SENTRY_ORG: 'org',
            SENTRY_PROJECT: 'project',
            VERCEL_ENV: 'preview',
            CI: 'false',
        });
        expect(options.authToken).toBeUndefined();
        expect(options.org).toBeUndefined();
        expect(options.project).toBeUndefined();
        expect(options.sourcemaps.disable).toBe(true);
        expect(options.webpack.disableSentryConfig).toBe(true);
    });

    it('permits upload only when CI and the dedicated gate are both explicitly true', () => {
        const options = sentryBuildOptions({
            CI: 'true',
            SENTRY_SOURCEMAPS_UPLOAD: 'true',
            SENTRY_AUTH_TOKEN: 'ci-build-token',
            SENTRY_ORG: 'org',
            SENTRY_PROJECT: 'project',
        });
        expect(options.authToken).toBe('ci-build-token');
        expect(options.sourcemaps.disable).toBe(false);
        expect(options.webpack.disableSentryConfig).toBe(false);
    });
});
