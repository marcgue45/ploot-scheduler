import { defineConfig } from "vitest/config";

const base = process.env.TEST_PG_URL ?? "postgres://postgres:postgres@localhost:5432";
const host = new URL(base).host;

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    fileParallelism: false, // una BD de test compartida
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      TEST_ADMIN_URL: `${base}/ploot_test`,
      DATABASE_URL: `postgres://ploot_app:app_local_pw@${host}/ploot_test`,
      WORKER_DATABASE_URL: `postgres://ploot_worker:worker_local_pw@${host}/ploot_test`,
      JWT_SECRET: "test-only-jwt-secret-0123456789abcdef",
      TOKEN_ENC_KEY: Buffer.alloc(32, 7).toString("base64"),
      LOG_LEVEL: "silent",
    },
  },
});
