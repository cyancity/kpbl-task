import crypto from "node:crypto";
import type { Page } from "@playwright/test";

// dev stack 地址（不走 vite 代理，直连后端与 mock，避免浏览器/页面上下文干扰）
export const API = "http://localhost:3000";
export const GATEWAY = "http://localhost:4000";
export const AGENT = "http://localhost:4100";

// apps/server/.env 里 dev server 的 JWT_SECRET
const JWT_SECRET = "dev-secret-change-me";

export interface AccountView {
  id: string;
  status: string;
  platformUserId: string | null;
}

export interface GroupView {
  id: string;
  gatewayGroupId: string | null;
  status: string;
  creatorAccountId: string;
  agentEnabled: boolean;
  autoKickEnabled: boolean;
  members: { accountId: string | null; platformUserId: string; role: string }[];
}

export interface AgentRunItem {
  id: string;
  status: string;
  endReason: string | null;
  createdAt: string;
}

async function api<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

export const apiGet = <T>(token: string, path: string) => api<T>(token, "GET", path);
export const apiPost = <T>(token: string, path: string, body?: unknown) =>
  api<T>(token, "POST", path, body);
export const apiPatch = <T>(token: string, path: string, body?: unknown) =>
  api<T>(token, "PATCH", path, body);

export async function adminToken(): Promise<string> {
  const res = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin" }),
  });
  if (!res.ok) throw new Error(`admin login failed: ${res.status}`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

export async function waitFor<T>(
  fn: () => Promise<T | null | undefined>,
  timeoutMs = 20_000,
  intervalMs = 200,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      lastErr = err;
    }
    if (Date.now() > deadline) {
      throw new Error(`waitFor timeout after ${timeoutMs}ms${lastErr ? ` (last: ${lastErr})` : ""}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export async function ensureOnline(token: string, accountId: string): Promise<void> {
  const accounts = await apiGet<AccountView[]>(token, "/api/accounts");
  const acc = accounts.find((a) => a.id === accountId);
  if (!acc) throw new Error(`account ${accountId} not found`);
  if (acc.status === "idle" || acc.status === "disconnected" || acc.status === "rate_limited") {
    await apiPost(token, `/api/accounts/${accountId}/connect`);
  } else if (acc.status !== "online") {
    throw new Error(`account ${accountId} is terminal (${acc.status}), cannot use in test`);
  }
  // dev 环境里 mock-gateway 是无状态内存进程：它一旦重启，DB 里仍 online 的
  // 账号在网关侧其实未连接（createGroup 会报 ACCOUNT_OFFLINE）。无论 DB
  // 状态如何，都直连网关补一次 connect 让两侧一致（mock connect 幂等）。
  const res = await fetch(`${GATEWAY}/accounts/${accountId}/connect`, { method: "POST" });
  if (!res.ok) {
    throw new Error(`gateway connect ${accountId} -> ${res.status}: ${await res.text()}`);
  }
}

/** 走 POST /api/groups 建群（gateway create → invite → join → promote），等 job 结束后返回群视图。 */
export async function createGroup(
  token: string,
  creatorAccountId: string,
  memberAccountIds: string[],
): Promise<GroupView> {
  await ensureOnline(token, creatorAccountId);
  for (const id of memberAccountIds) await ensureOnline(token, id);
  const res = await apiPost<{ jobId: string; groupId: string }>(token, "/api/groups", {
    creatorAccountId,
    memberAccountIds,
  });
  await waitFor(async () => {
    const job = await apiGet<{ status: string; errors: { step: string; code: string }[] }>(
      token,
      `/api/jobs/${res.jobId}`,
    );
    if (job.status === "failed") throw new Error(`create_group job failed: ${JSON.stringify(job.errors)}`);
    return job.status === "finished" ? true : null;
  });
  return apiGet<GroupView>(token, `/api/groups/${res.groupId}`);
}

/** 让 mock-gateway 推一条外部用户 message 事件（不经 UI）。 */
export async function externalMessage(
  gatewayGroupId: string,
  platformUserId: string,
  text: string,
): Promise<void> {
  const res = await fetch(`${GATEWAY}/__admin/groups/${gatewayGroupId}/external-message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ platformUserId, text }),
  });
  if (!res.ok) throw new Error(`external-message -> ${res.status}: ${await res.text()}`);
}

/** mock-agent 剧本：按 runId 前缀匹配，"*" 匹配全部 run。每次调用覆盖全部剧本。 */
export async function setAgentScript(steps: unknown[], key = "*"): Promise<void> {
  const res = await fetch(`${AGENT}/__admin/script`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runs: { [key]: steps } }),
  });
  if (!res.ok) throw new Error(`agent script -> ${res.status}`);
}

export async function resetAgent(): Promise<void> {
  const res = await fetch(`${AGENT}/__admin/reset`, { method: "POST" });
  if (!res.ok) throw new Error(`agent reset -> ${res.status}`);
}

/**
 * 等当前没有任何 running 的 agent run。mock-agent 的 "*" 剧本是所有 run 共享的一个
 * 队列（每次 /agent/turn shift 一步），别的 run 还活着会把我们刚设的剧本吃掉——
 * 所以每个用例在设剧本/触发 run 之前先等全局静默。
 */
export async function waitForNoRunningAgentRuns(
  token: string,
  timeoutMs = 60_000,
): Promise<void> {
  await waitFor(async () => {
    const groups = await apiGet<{ id: string }[]>(token, "/api/groups");
    const lists = await Promise.all(
      groups.map((g) => apiGet<AgentRunItem[]>(token, `/api/groups/${g.id}/agent-runs`)),
    );
    return lists.every((l) => l.every((r) => r.status !== "running")) ? true : null;
  }, timeoutMs);
}

/** 用 dev 的 JWT_SECRET 把真实 token 重签成一个"已过期"的 token（保持 sid 不变）。 */
export function expiredAccessToken(realToken: string): string {
  const payload = JSON.parse(
    Buffer.from(realToken.split(".")[1]!, "base64url").toString("utf8"),
  ) as Record<string, unknown>;
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now - 1800, exp: now - 900 };
  const seg = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const data = `${seg({ alg: "HS256", typ: "JWT" })}.${seg(body)}`;
  const sig = crypto.createHmac("sha256", JWT_SECRET).update(data).digest("base64url");
  return `${data}.${sig}`;
}

export async function uiLogin(page: Page, username: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("用户名").fill(username);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.waitForURL("**/groups");
}
