import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 120_000,
    hookTimeout: 90_000,
    fileParallelism: false,
    maxConcurrency: 1,
    include: ["test/adversarial/**/*.test.ts"],
    env: {
      ADV_DATABASE_URL:
        process.env.ADV_DATABASE_URL ?? "postgres://gmp:gmp@localhost:5432/gmp_adv",
      JWT_SECRET: "adv-secret",
    },
  },
});
