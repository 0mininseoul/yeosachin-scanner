import type { NextConfig } from "next";
import { withSentryConfig } from '@sentry/nextjs';

const nextConfig: NextConfig = {
  serverExternalPackages: ["@google-cloud/tasks", "google-auth-library", "google-gax"],
  outputFileTracingIncludes: {
    "/api/analysis/start": ["./node_modules/@google-cloud/tasks/build/protos/**/*"],
    "/api/analysis/step": ["./node_modules/@google-cloud/tasks/build/protos/**/*"],
    "/api/analysis/preflight": ["./node_modules/@google-cloud/tasks/build/protos/**/*"],
    "/api/analysis/preflight/[preflightId]/entitle": ["./node_modules/@google-cloud/tasks/build/protos/**/*"],
    "/api/analysis/v2/recover": ["./node_modules/@google-cloud/tasks/build/protos/**/*"],
    "/api/analysis/v2/worker": ["./node_modules/@google-cloud/tasks/build/protos/**/*"],
  },
};

export default withSentryConfig(nextConfig, {
  // Auth is only used in CI/build to upload source maps; it is never a runtime secret.
  authToken: process.env.SENTRY_AUTH_TOKEN,
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  silent: true,
  sourcemaps: {
    disable: !process.env.SENTRY_AUTH_TOKEN,
  },
  telemetry: false,
});
