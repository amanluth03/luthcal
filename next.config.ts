import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root so Next doesn't infer it from a stray parent-dir lockfile.
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
