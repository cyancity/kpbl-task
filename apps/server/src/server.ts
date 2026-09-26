import { loadConfig } from "./config.js";
import { createPool } from "./db/pool.js";
import { checkSchemaVersion } from "./db/migrate.js";
import { buildApp } from "./app.js";
import { startWorkers, type WorkersHandle } from "./workers/index.js";

const config = loadConfig();

const behind = await checkSchemaVersion(createPool(config.databaseUrl));
if (behind) {
  console.error(
    `Database schema is behind: current=${behind.current} expected=${behind.expected}. Run npm run migrate -w apps/server.`,
  );
  process.exit(1);
}

const app = await buildApp(config);

let workers: WorkersHandle | null = null;
if (process.env.WORKERS !== "0") {
  workers = startWorkers(app.ctx);
}
app.addHook("onClose", async () => {
  await workers?.stop();
});

try {
  await app.listen({ port: config.port, host: "0.0.0.0" });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
