import type { NextConfig } from "next";
import { withSentryConfig } from '@sentry/nextjs';
import {
  sentryBuildOptions,
  shouldConfigureSentryBuild,
} from './lib/observability/sentry-build-options';

const cloudTasksBuildTrace = ["./node_modules/@google-cloud/tasks/build/**/*"];

const nextConfig: NextConfig = {
  serverExternalPackages: ["@google-cloud/tasks", "google-auth-library", "google-gax"],
  outputFileTracingIncludes: {
    "/api/analysis/start": cloudTasksBuildTrace,
    "/api/analysis/step": cloudTasksBuildTrace,
    "/api/analysis/preflight": cloudTasksBuildTrace,
    "/api/analysis/preflight/[preflightId]/entitle": cloudTasksBuildTrace,
    "/api/analysis/betatest/preflight/[preflightId]/admit": cloudTasksBuildTrace,
    "/api/analysis/v2/recover": cloudTasksBuildTrace,
    "/api/analysis/v2/worker": cloudTasksBuildTrace,
  },
};

const shouldConfigureSentry = shouldConfigureSentryBuild();

// Do not invoke withSentryConfig at all outside the explicit CI upload gate.
// Turbopack's runAfterProductionCompile lifecycle can otherwise instantiate release work.
export default shouldConfigureSentry
  ? withSentryConfig(nextConfig, sentryBuildOptions())
  : nextConfig;
