import type { NextConfig } from "next";
import { withSentryConfig } from '@sentry/nextjs';
import {
  sentryBuildOptions,
  shouldConfigureSentryBuild,
} from './lib/observability/sentry-build-options';
import { CHERRY_LANDING_PATH, CHERRY_PUBLIC_HOST } from './lib/constants/cherry-public-url';

const cloudTasksBuildTrace = ["./node_modules/@google-cloud/tasks/build/**/*"];

const nextConfig: NextConfig = {
  serverExternalPackages: ["@google-cloud/tasks", "google-auth-library", "google-gax"],
  outputFileTracingIncludes: {
    "/cherry": ["./public/cherry/landing.html"],
    "/cherry-public-landing": ["./public/cherry/landing.html"],
    "/cherry-public-landing/ex": ["./public/cherry/landing.html"],
    "/api/analysis/start": cloudTasksBuildTrace,
    "/api/analysis/step": cloudTasksBuildTrace,
    "/api/analysis/preflight": cloudTasksBuildTrace,
    "/api/analysis/preflight/[preflightId]/entitle": cloudTasksBuildTrace,
    "/api/analysis/betatest/preflight/[preflightId]/admit": cloudTasksBuildTrace,
    "/api/analysis/v2/recover": cloudTasksBuildTrace,
    "/api/analysis/v2/worker": cloudTasksBuildTrace,
    "/api/cherry/target-checks": cloudTasksBuildTrace,
  },
  async rewrites() {
    return {
      beforeFiles: [{
        source: '/',
        has: [{ type: 'host', value: CHERRY_PUBLIC_HOST.replaceAll('.', '\\.') }],
        destination: CHERRY_LANDING_PATH,
      }, {
        source: '/ex',
        has: [{ type: 'host', value: CHERRY_PUBLIC_HOST.replaceAll('.', '\\.') }],
        destination: `${CHERRY_LANDING_PATH}/ex`,
      }],
      afterFiles: [],
      fallback: [],
    };
  },
  // Cherry moved from /namchin to /cherry (PR 673). Meta (Threads, Instagram) keeps cached share cards
  // that still point at the old image, which otherwise 404s and renders as a blank card.
  async redirects() {
    return [
      { source: "/cherry/landing.html", destination: "/cherry", permanent: true },
      { source: "/namchin", destination: "/cherry", permanent: true },
      { source: "/namchin/og.jpg", destination: "/cherry/og.jpg", permanent: true },
    ];
  },
};

const shouldConfigureSentry = shouldConfigureSentryBuild();

// Do not invoke withSentryConfig at all outside the explicit CI upload gate.
// Turbopack's runAfterProductionCompile lifecycle can otherwise instantiate release work.
export default shouldConfigureSentry
  ? withSentryConfig(nextConfig, sentryBuildOptions())
  : nextConfig;
