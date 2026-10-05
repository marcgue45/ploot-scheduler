import type { NextConfig } from "next";

const config: NextConfig = {
  transpilePackages: ["@ploot/shared"],
  serverExternalPackages: ["pg", "pino"],
  poweredByHeader: false,
};

export default config;
