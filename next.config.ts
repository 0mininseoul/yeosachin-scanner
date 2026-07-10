import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@google-cloud/tasks", "google-auth-library"],
  outputFileTracingIncludes: {
    "/api/analysis/start": ["./node_modules/@google-cloud/tasks/build/protos/**/*"],
    "/api/analysis/step": ["./node_modules/@google-cloud/tasks/build/protos/**/*"],
  },
};

export default nextConfig;
