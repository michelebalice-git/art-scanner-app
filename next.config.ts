import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep Node-only natives out of the serverless bundle. The CLIP model runs in the browser.
  serverExternalPackages: ["sharp", "onnxruntime-node"],
  turbopack: {},
  webpack: (config, { isServer }) => {
    if (!isServer) {
      const alias = config.resolve.alias;
      config.resolve.alias = {
        ...(alias && !Array.isArray(alias) ? alias : {}),
        sharp: false,
        "onnxruntime-node": false,
      };
    }
    return config;
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "www.pkb.ch",
        pathname: "/wp-content/uploads/**",
        search: "",
      },
    ],
  },
};

export default nextConfig;
