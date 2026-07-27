/** Source-map upload is an explicit CI-only release action, never a local token side effect. */
export function sentryBuildOptions(
    environment: Readonly<Record<string, string | undefined>> = process.env,
) {
    const uploadEnabled = environment.CI === 'true'
        && environment.SENTRY_SOURCEMAPS_UPLOAD === 'true'
        && Boolean(environment.SENTRY_AUTH_TOKEN);

    return {
        authToken: uploadEnabled ? environment.SENTRY_AUTH_TOKEN : undefined,
        org: uploadEnabled ? environment.SENTRY_ORG : undefined,
        project: uploadEnabled ? environment.SENTRY_PROJECT : undefined,
        silent: true,
        sourcemaps: { disable: !uploadEnabled },
        telemetry: false,
    };
}
