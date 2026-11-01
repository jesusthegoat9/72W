import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Cache Components / PPR is off on purpose: the Cloudflare OpenNext adapter
  // has open issues with it on Next 16.4, and vinext documents it as
  // incomplete. DB-backed routes opt into dynamic rendering explicitly.
  cacheComponents: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
