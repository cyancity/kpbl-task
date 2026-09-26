export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const TOKEN_KEY = "gmp_access_token";
let accessToken: string | null = sessionStorage.getItem(TOKEN_KEY);

export function getAccessToken(): string | null {
  return accessToken;
}

export function setAccessToken(token: string | null): void {
  accessToken = token;
  if (token) sessionStorage.setItem(TOKEN_KEY, token);
  else sessionStorage.removeItem(TOKEN_KEY);
}

let onAuthExpired: () => void = () => {};
export function setAuthExpiredHandler(fn: () => void): void {
  onAuthExpired = fn;
}

let refreshPromise: Promise<boolean> | null = null;

async function doRefresh(): Promise<boolean> {
  try {
    const res = await fetch("/api/auth/refresh", { method: "POST" });
    if (!res.ok) return false;
    const body = (await res.json()) as { accessToken?: string };
    if (!body.accessToken) return false;
    setAccessToken(body.accessToken);
    return true;
  } catch {
    return false;
  }
}

export function refreshToken(): Promise<boolean> {
  refreshPromise ??= doRefresh().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

async function parseError(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as {
      error?: { code?: string; message?: string } & Record<string, unknown>;
    };
    if (body.error) {
      const { code, message, ...extra } = body.error;
      return new ApiError(res.status, code ?? "INTERNAL", message ?? res.statusText, extra);
    }
  } catch {
    // fall through
  }
  return new ApiError(res.status, "INTERNAL", res.statusText || "request failed");
}

export async function apiFetch(
  path: string,
  init: RequestInit = {},
  retried = false,
): Promise<unknown> {
  const headers: Record<string, string> = {
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (init.body && !headers["content-type"] && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(path, { ...init, headers });
  if (res.status === 401 && !retried) {
    if (await refreshToken()) return apiFetch(path, init, true);
    setAccessToken(null);
    onAuthExpired();
    throw new ApiError(401, "UNAUTHORIZED", "session expired");
  }
  if (!res.ok) throw await parseError(res);
  if (res.status === 204) return null;
  return res.json();
}
