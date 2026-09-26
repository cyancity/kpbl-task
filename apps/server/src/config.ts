export interface AppConfig {
  port: number;
  databaseUrl: string;
  gatewayUrl: string;
  agentUrl: string;
  jwtSecret: string;
  joinTimeoutMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  return {
    port: Number(env.PORT ?? 3000),
    databaseUrl,
    gatewayUrl: env.GATEWAY_URL ?? "http://localhost:4000",
    agentUrl: env.AGENT_URL ?? "http://localhost:4100",
    jwtSecret: env.JWT_SECRET ?? "dev-secret",
    joinTimeoutMs: Number(env.JOIN_TIMEOUT_MS ?? 10_000),
  };
}
