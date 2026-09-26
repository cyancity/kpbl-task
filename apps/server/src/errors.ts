export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validates a UUID path param; non-UUID values get a clean 404 instead of a
 *  pg 22P02 crash from the uuid column comparison. */
export function requireUuid(value: string, notFoundCode: string): string {
  if (!UUID_RE.test(value)) {
    throw new AppError(404, notFoundCode, `invalid id: ${value}`);
  }
  return value;
}
