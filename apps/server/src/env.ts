/**
 * Loads `.env` from the app working directory when present (Node's built-in
 * dotenv support). No-ops when the file is absent so tests/production that set
 * real env vars are unaffected; `.env` only fills in missing vars.
 */
export function loadLocalEnv(path = ".env"): void {
  try {
    process.loadEnvFile(path);
  } catch {
    // .env missing — rely on the process environment
  }
}
