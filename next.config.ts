import type { NextConfig } from "next";

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

export default nextConfig;
