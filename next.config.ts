import type { NextConfig } from "next";
import { withSentryConfig } from '@sentry/nextjs';
import {
  sentryBuildOptions,
  shouldConfigureSentryBuild,
} from './lib/observability/sentry-build-options';

const nextConfig: NextConfig = {
  serverExternalPackages: ["@google-cloud/tasks", "google-auth-library", "google-gax", "sharp"],
  outputFileTracingIncludes: {
    "/mypage": ["./node_modules/sharp/**/*", "./node_modules/@img/**/*"],
    "/api/share/[token]/image": ["./node_modules/sharp/**/*", "./node_modules/@img/**/*"],
    "/api/share/[token]/opengraph-image": ["./node_modules/sharp/**/*", "./node_modules/@img/**/*"],
    "/api/analysis/start": ["./node_modules/@google-cloud/tasks/build/protos/**/*"],
    "/api/analysis/step": ["./node_modules/@google-cloud/tasks/build/protos/**/*"],
    "/api/analysis/preflight": ["./node_modules/@google-cloud/tasks/build/protos/**/*"],
    "/api/analysis/preflight/[preflightId]/entitle": ["./node_modules/@google-cloud/tasks/build/protos/**/*"],
    "/api/analysis/v2/recover": ["./node_modules/@google-cloud/tasks/build/protos/**/*"],
    "/api/analysis/v2/worker": ["./node_modules/@google-cloud/tasks/build/protos/**/*"],
  },
};

const shouldConfigureSentry = shouldConfigureSentryBuild();

// Do not invoke withSentryConfig at all outside the explicit CI upload gate.
// Turbopack's runAfterProductionCompile lifecycle can otherwise instantiate release work.
export default shouldConfigureSentry
  ? withSentryConfig(nextConfig, sentryBuildOptions())
  : nextConfig;
