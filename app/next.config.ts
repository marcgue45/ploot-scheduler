import { join } from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
  transpilePackages: ["@ploot/shared"],
  serverExternalPackages: ["pg", "pino"],
  poweredByHeader: false,
  // Solo en la imagen Docker: servidor autocontenido y pequeño. Vercel no lo necesita.
  ...(process.env.NEXT_STANDALONE ? { output: "standalone" as const, outputFileTracingRoot: join(import.meta.dirname, "..") } : {}),
};

export default config;
