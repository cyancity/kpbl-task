import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { apiFetch, setAccessToken } from "./client";

describe("apiFetch single-flight refresh", () => {
  beforeEach(() => {
    sessionStorage.clear();
    setAccessToken("old-token");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("3 concurrent 401s trigger exactly one /api/auth/refresh", async () => {
    let refreshes = 0;
    const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/auth/refresh") {
        refreshes++;
        await new Promise((r) => setTimeout(r, 20));
        return new Response(JSON.stringify({ accessToken: "new-token" }), { status: 200 });
      }
      const h = (init?.headers ?? {}) as Record<string, string>;
      if (h.Authorization === "Bearer old-token") {
        return new Response(
          JSON.stringify({ error: { code: "UNAUTHORIZED", message: "x" } }),
          { status: 401 },
        );
      }
      return new Response(JSON.stringify({ ok: url }), { status: 200 });
    });
    vi.stubGlobal("fetch", mock);

    const results = await Promise.all([
      apiFetch("/api/accounts"),
      apiFetch("/api/groups"),
      apiFetch("/api/sequences"),
    ]);
    expect(refreshes).toBe(1);
    expect(results).toHaveLength(3);
  });

  it("failed refresh clears the token and surfaces 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/auth/refresh") {
          return new Response("nope", { status: 401 });
        }
        return new Response("unauthorized", { status: 401 });
      }),
    );
    await expect(apiFetch("/api/accounts")).rejects.toMatchObject({
      status: 401,
      code: "UNAUTHORIZED",
    });
    expect(sessionStorage.getItem("gmp_access_token")).toBeNull();
  });
});
