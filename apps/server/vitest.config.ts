import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 20000,
    hookTimeout: 30000,
    fileParallelism: false,
    exclude: ["test/adversarial/**", "node_modules/**"],
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://devin@localhost:5432/gmp_test",
      JWT_SECRET: "test-secret",
    },
  },
});
