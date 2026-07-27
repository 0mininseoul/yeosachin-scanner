export type BuildEnvironment = Readonly<Record<string, string | undefined>>;

/** Source-map upload is an explicit CI-only release action, never a local token side effect. */
export function shouldConfigureSentryBuild(
    environment: BuildEnvironment = process.env,
): boolean {
    return (environment.CI === 'true' || environment.CI === '1')
        && environment.SENTRY_SOURCEMAPS_UPLOAD === 'true'
        && Boolean(environment.SENTRY_AUTH_TOKEN);
}

export function sentryBuildOptions(
    environment: BuildEnvironment = process.env,
) {
    const uploadEnabled = shouldConfigureSentryBuild(environment);

    return {
        authToken: uploadEnabled ? environment.SENTRY_AUTH_TOKEN : undefined,
        org: uploadEnabled ? environment.SENTRY_ORG : undefined,
        project: uploadEnabled ? environment.SENTRY_PROJECT : undefined,
        silent: true,
        sourcemaps: { disable: !uploadEnabled },
        // Prevent withSentryConfig from installing the webpack plugin/release hooks at all.
        webpack: { disableSentryConfig: !uploadEnabled },
        telemetry: false,
    };
}
