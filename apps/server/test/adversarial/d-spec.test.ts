import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import {
	ADV_DB_URL,
	migrateAdvDb,
	resetAdvDb,
	startMocks,
	spawnServer,
	kill9,
	waitFor,
	gwAdmin,
	agentAdmin,
	type AdvEnv,
	type ServerHandle,
} from "./helpers.js";
import { login as appLogin } from "../helpers.js";

// NOTE: 本文件自带 apiReq/seedGroup，不依赖 helpers 里的 api()/seedGroupAdv()，
// 以免受共享 helper 演化的影响；路径参数填充、Bearer 头均由本地实现保证。

async function apiReq(
	h: ServerHandle,
	method: string,
	path: string,
	token?: string,
	body?: unknown,
): Promise<{ status: number; body: unknown }> {
	const res = await fetch(`${h.base}${path}`, {
		method,
		headers: {
			...(token ? { authorization: `Bearer ${token}` } : {}),
			...(body !== undefined ? { "content-type": "application/json" } : {}),
		},
		body: body !== undefined ? JSON.stringify(body) : null,
	});
	const text = await res.text();
	let json: unknown = null;
	try {
		json = JSON.parse(text);
	} catch {
		json = text;
	}
	return { status: res.status, body: json };
}

async function adminToken(h: ServerHandle): Promise<string> {
	const res = await apiReq(h, "POST", "/api/auth/login", undefined, {
		username: "admin",
		password: "admin",
	});
	if (res.status !== 200) {
		throw new Error(`admin login failed: ${JSON.stringify(res.body)}`);
	}
	return (res.body as { accessToken: string }).accessToken;
}

/** seedGroupAdv equivalent with working Bearer auth. */
async function seedGroup(
	h: ServerHandle,
	token: string,
	memberAccountIds: string[] = ["acc-2"],
): Promise<{ groupId: string; gatewayGroupId: string }> {
	for (const id of ["acc-1", ...memberAccountIds]) {
		const res = await apiReq(h, "POST", `/api/accounts/${id}/connect`, token);
		if (res.status !== 200) {
			// 上一轮可能已经 connect 过 → online→online 属于非法转移，容忍
			const code = (res.body as { error?: { code?: string } }).error?.code;
			if (code !== "ILLEGAL_TRANSITION") {
				throw new Error(`connect ${id}: ${JSON.stringify(res.body)}`);
			}
		}
	}
	const g = await gwAdmin(env, "POST", "/groups", { creatorAccountId: "acc-1" });
	const gatewayGroupId = (g.body as { groupId: string }).groupId;
	const groupId = crypto.randomUUID();
	await env.pool.query(
		"INSERT INTO groups (id, gateway_group_id, status, creator_account_id) VALUES ($1,$2,'active','acc-1')",
		[groupId, gatewayGroupId],
	);
	await env.pool.query(
		"INSERT INTO group_members (group_id, account_id, platform_user_id, role) VALUES ($1,'acc-1','pu-acc-1','creator')",
		[groupId],
	);
	for (const id of memberAccountIds) {
		await env.pool.query(
			"INSERT INTO group_members (group_id, account_id, platform_user_id, role) VALUES ($1,$2,$3,'member')",
			[groupId, id, `pu-${id}`],
		);
		await gwAdmin(env, "POST", `/__admin/groups/${gatewayGroupId}/external-join`, {
			platformUserId: `pu-${id}`,
		});
	}
	return { groupId, gatewayGroupId };
}

/**
 * D 节：协议/规范一致性（P1–P7）。断言忠于 spec 2.2/2.3/A0/A5；
 * 发现实现不符时测试保持失败并记录，不做弱化。
 */

let env: AdvEnv;
let inProcApp: FastifyInstance; // 仅用于 P1 的路由枚举 + inject 调用

// spawnServer 超时会留下半启动的进程树（helpers 的 deadline kill 只杀 npx
// 包装进程）；测试中途断言失败也可能跳过行内 kill9。这里统一登记存活句柄，
// afterAll 兜底全杀，防止孤儿 server 继续消费共享 DB 的 SSE/outbox/agent 任务。
const liveServers = new Set<ServerHandle>();

async function spawnTracked(
	extraEnv: Record<string, string> = {},
): Promise<ServerHandle> {
	const h = await spawnServer(env, extraEnv);
	liveServers.add(h);
	return h;
}

function killTracked(h: ServerHandle | undefined): void {
	if (!h) return;
	kill9(h); // helpers 的进程组级 SIGKILL
	liveServers.delete(h);
}

/** 失败诊断：打印 spawned server 的退出码与 stderr 尾部。 */
function dumpServer(h: ServerHandle, tag: string): void {
	console.error(
		`[${tag}] proc.pid=${h.proc.pid} exitCode=${h.proc.exitCode} ` +
			`signal=${h.proc.signalCode}\nstderr tail:\n${h.stderr().slice(-2000)}`,
	);
}

const SERVER_DIR = new URL("../../", import.meta.url).pathname;

beforeAll(async () => {
	await migrateAdvDb();
	env = await startMocks();
	inProcApp = await buildApp({
		port: 0,
		databaseUrl: ADV_DB_URL,
		gatewayUrl: env.gatewayUrl,
		agentUrl: env.agentUrl,
		jwtSecret: "adv-secret",
		joinTimeoutMs: 8000,
		agentTurnTimeoutMs: 4000,
		auditTimeoutMs: 1000,
		agentLeaseMs: 15_000,
	});
});

async function closeQuietly(p: Promise<unknown>): Promise<void> {
	// mock-gateway 没有 forceCloseConnections：被 SIGKILL 的 spawned server
	// 留下的 SSE socket 可能让 app.close() 长时间挂起，给每个 close 设上限。
	await Promise.race([
		p.catch(() => {}),
		new Promise((r) => setTimeout(r, 5000)),
	]);
}

afterAll(async () => {
	for (const h of [...liveServers]) killTracked(h);
	await closeQuietly(inProcApp.close());
	await closeQuietly(env.gatewayApp.close());
	await closeQuietly(env.agentApp.close());
	await closeQuietly(env.pool.end());
});

async function resetMocks(): Promise<void> {
	await env.gatewayApp.inject({ method: "POST", url: "/__admin/reset" });
	// /__admin/reset 恢复默认时延，重新压到快速档
	await env.gatewayApp.inject({
		method: "POST",
		url: "/__admin/config",
		payload: {
			sendDelayMinMs: 10,
			sendDelayMaxMs: 30,
			joinDelayMinMs: 10,
			joinDelayMaxMs: 50,
			kickDelayMinMs: 10,
			kickDelayMaxMs: 50,
		},
	});
	await env.agentApp.inject({ method: "POST", url: "/__admin/reset" });
}

async function boot(): Promise<{ h: ServerHandle; token: string }> {
	await resetAdvDb(env.pool);
	await resetMocks();
	const h = await spawnTracked();
	try {
		const token = await adminToken(h);
		return { h, token };
	} catch (err) {
		dumpServer(h, "boot");
		killTracked(h);
		throw err;
	}
}

interface AgentTurnBody {
	runId: string;
	tools: {
		name: string;
		description?: unknown;
		input_schema?: {
			type?: string;
			properties?: Record<string, unknown>;
			required?: string[];
		};
	}[];
	messages: {
		role: string;
		content: {
			type: string;
			text?: string;
			id?: string;
			name?: string;
			input?: unknown;
			tool_use_id?: string;
			content?: string;
			is_error?: boolean;
		}[];
	}[];
}

interface AgentAdminState {
	turnCalls: { runId: string; body: AgentTurnBody }[];
	turnCallsByRun: Record<string, AgentTurnBody[]>;
	auditCalls: { body: { text?: string; groupId?: string } }[];
}

async function agentState(): Promise<AgentAdminState> {
	return (await agentAdmin(env, "GET", "/__admin/state")) as AgentAdminState;
}

async function setScript(steps: unknown[], audit?: unknown[]): Promise<void> {
	await agentAdmin(env, "POST", "/__admin/script", {
		runs: { "*": steps },
		...(audit ? { audit } : {}),
	});
}

async function externalJoin(gatewayGroupId: string, platformUserId: string) {
	await gwAdmin(env, "POST", `/__admin/groups/${gatewayGroupId}/external-join`, {
		platformUserId,
	});
}

async function externalMessage(
	gatewayGroupId: string,
	platformUserId: string,
	text: string,
) {
	await gwAdmin(env, "POST", `/__admin/groups/${gatewayGroupId}/external-message`, {
		platformUserId,
		text,
	});
}

interface RunListItem {
	id: string;
	status: string;
	endReason: string | null;
}

async function listRuns(
	h: ServerHandle,
	token: string,
	groupId: string,
): Promise<RunListItem[]> {
	const res = await apiReq(h, "GET", `/api/groups/${groupId}/agent-runs`, token);
	return res.body as RunListItem[];
}

/** Waits until the latest agent run of a group leaves `running`; returns its id. */
async function waitLatestRunDone(
	h: ServerHandle,
	token: string,
	groupId: string,
): Promise<string> {
	let runId = "";
	await waitFor(async () => {
		const arr = await listRuns(h, token, groupId);
		if (arr[0] && arr[0].status !== "running") {
			runId = arr[0].id;
			return true;
		}
		return false;
	}, 20_000);
	return runId;
}

interface StepView {
	seq: number;
	kind: string;
	toolUseId: string | null;
	name: string | null;
	input: unknown;
	resultSummary: string | null;
	isError: boolean;
	errorCode: string | null;
	auditVerdict: string | null;
	rawResponse: string | null;
}

interface RunDetail {
	id: string;
	status: string;
	endReason: string | null;
	summary: string | null;
	steps: StepView[];
}

async function runDetail(
	h: ServerHandle,
	token: string,
	runId: string,
): Promise<RunDetail> {
	const res = await apiReq(h, "GET", `/api/agent-runs/${runId}`, token);
	return res.body as RunDetail;
}

// ---------------------------------------------------------------------------
// P1: 路由清单 + viewer 403 / 无 token 401
// ---------------------------------------------------------------------------

interface RouteEntry {
	method: string;
	path: string;
}

/** Parses `app.printRoutes()` tree output into method+path pairs. */
function listRoutes(app: FastifyInstance): RouteEntry[] {
	const tree = app.printRoutes();
	const routes: RouteEntry[] = [];
	const stack: string[] = [];
	for (const line of tree.split("\n")) {
		const m = line.match(/^(.*?)(├── |└── )(.*)$/);
		if (!m) continue;
		const depth = Math.floor(m[1]!.length / 4);
		let segment = m[3]!.trimEnd();
		let methods: string[] = [];
		const mm = segment.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
		if (mm) {
			segment = mm[1]!;
			methods = mm[2]!.split(",").map((s) => s.trim());
		}
		stack[depth] = segment;
		stack.length = depth + 1;
		for (const method of methods) {
			routes.push({ method, path: stack.join("") });
		}
	}
	return routes;
}

const PUBLIC_PATHS = new Set(["/api/auth/login", "/api/health"]);
// Cookie-based session endpoints: auth via refresh_token cookie, not Bearer JWT.
const COOKIE_AUTH_PATHS = new Set(["/api/auth/refresh", "/api/auth/logout"]);
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function fillParams(path: string): string {
	// 用合法格式的 UUID 占位：服务端 id 列是 uuid，"x" 会触发 pg 22P02 → 500。
	return path.replace(/:[^/]+/g, "00000000-0000-0000-0000-000000000000");
}

interface ErrBody {
	error?: { code?: string; message?: string; requestId?: string };
}

function checkErrEnvelope(
	body: unknown,
	code: string,
	label: string,
	failures: string[],
): void {
	const b = body as ErrBody;
	if (b?.error?.code !== code) {
		failures.push(`${label}: error.code=${b?.error?.code} expected ${code}`);
	}
	if (typeof b?.error?.requestId !== "string" || !b.error.requestId) {
		failures.push(`${label}: missing error.requestId`);
	}
	if (typeof b?.error?.message !== "string") {
		failures.push(`${label}: missing error.message`);
	}
}

describe("P1 auth matrix over enumerated routes", () => {
	it("P1 write routes: viewer -> 403 FORBIDDEN, no token -> 401 UNAUTHORIZED; GET readable by viewer", async () => {
		await resetAdvDb(env.pool);
		await resetMocks();
		const viewer = (await appLogin(inProcApp, "viewer", "viewer")).accessToken;
		const routes = listRoutes(inProcApp);

		// Sanity: the parser must see the spec'd endpoints.
		const writePaths = new Set(
			routes.filter((r) => WRITE_METHODS.has(r.method)).map((r) => r.path),
		);
		for (const p of [
			"/api/accounts/:id/connect",
			"/api/accounts/:id/transition",
			"/api/groups",
			"/api/groups/:id",
			"/api/groups/:id/send",
			"/api/groups/:id/leave-all",
			"/api/sequences",
			"/api/groups/:id/sequence-runs",
		]) {
			expect(writePaths, `route missing from printRoutes: ${p}`).toContain(p);
		}

		const failures: string[] = [];
		for (const r of routes) {
			if (r.method === "HEAD") continue; // auto-added twin of GET, covered by it
			if (!r.path.startsWith("/api/")) continue; // /ws: auth via first WS frame, not HTTP
			if (PUBLIC_PATHS.has(r.path) || COOKIE_AUTH_PATHS.has(r.path)) continue;
			const url = fillParams(r.path);
			const label = `${r.method} ${r.path}`;

			// no token -> 401 UNAUTHORIZED (every non-public /api route)
			const resAnon = await inProcApp.inject({ method: r.method as "GET", url });
			if (resAnon.statusCode !== 401) {
				failures.push(`${label}: anonymous -> ${resAnon.statusCode}, expected 401`);
			} else {
				checkErrEnvelope(resAnon.json(), "UNAUTHORIZED", `${label} anon`, failures);
			}

			if (WRITE_METHODS.has(r.method)) {
				const resViewer = await inProcApp.inject({
					method: r.method as "POST",
					url,
					headers: { authorization: `Bearer ${viewer}` },
				});
				if (resViewer.statusCode !== 403) {
					failures.push(`${label}: viewer -> ${resViewer.statusCode}, expected 403`);
				} else {
					checkErrEnvelope(resViewer.json(), "FORBIDDEN", `${label} viewer`, failures);
				}
			} else if (r.method === "GET") {
				// viewer is a read role: must not get 401/403
				const resViewer = await inProcApp.inject({
					method: "GET",
					url,
					headers: { authorization: `Bearer ${viewer}` },
				});
				if (resViewer.statusCode === 401 || resViewer.statusCode === 403) {
					failures.push(`${label}: viewer read -> ${resViewer.statusCode}`);
				}
				if (resViewer.statusCode >= 500) {
					failures.push(`${label}: viewer read -> ${resViewer.statusCode}`);
				}
			}
		}
		expect(failures).toEqual([]);
	});

	it("P1 auth endpoints and public paths behave per spec", async () => {
		await resetAdvDb(env.pool);
		// login is public and returns a token for viewer
		const resLogin = await inProcApp.inject({
			method: "POST",
			url: "/api/auth/login",
			payload: { username: "viewer", password: "viewer" },
		});
		expect(resLogin.statusCode).toBe(200);
		expect(typeof (resLogin.json() as { accessToken?: string }).accessToken).toBe(
			"string",
		);
		const cookies = resLogin.cookies.map((c) => `${c.name}=${c.value}`);

		// health is public
		const resHealth = await inProcApp.inject({ method: "GET", url: "/api/health" });
		expect(resHealth.statusCode).toBe(200);

		// refresh without cookie -> 401 UNAUTHORIZED; with viewer cookie -> 200
		const resRefreshAnon = await inProcApp.inject({
			method: "POST",
			url: "/api/auth/refresh",
		});
		expect(resRefreshAnon.statusCode).toBe(401);
		expect((resRefreshAnon.json() as ErrBody).error?.code).toBe("UNAUTHORIZED");
		const resRefresh = await inProcApp.inject({
			method: "POST",
			url: "/api/auth/refresh",
			headers: { cookie: cookies.join("; ") },
		});
		expect(resRefresh.statusCode).toBe(200);

		// logout without a session cookie: spec does not pin a status; must not 5xx.
		const resLogout = await inProcApp.inject({ method: "POST", url: "/api/auth/logout" });
		expect(resLogout.statusCode).toBeLessThan(500);
	});
});

// ---------------------------------------------------------------------------
// P2: GET 响应时间字段一律 ISO 8601 UTC 或 null
// ---------------------------------------------------------------------------

const TIME_KEY = /(?:At|Until)$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

function scanTimes(node: unknown, path: string, violations: string[]): void {
	if (Array.isArray(node)) {
		node.forEach((v, i) => scanTimes(v, `${path}[${i}]`, violations));
		return;
	}
	if (node && typeof node === "object") {
		for (const [k, v] of Object.entries(node)) {
			const p = `${path}.${k}`;
			if (
				TIME_KEY.test(k) &&
				v !== null &&
				!(typeof v === "string" && ISO_UTC.test(v))
			) {
				violations.push(`${p} = ${JSON.stringify(v)}`);
			}
			scanTimes(v, p, violations);
		}
	}
}

describe("P2 timestamp format sweep", () => {
	it("P2 all GET responses carry ISO-8601 UTC strings or null in *At/*Until fields", async () => {
		const { h, token } = await boot();
		try {
			const { groupId, gatewayGroupId } = await seedGroup(h, token);
			await apiReq(h, "PATCH", `/api/groups/${groupId}`, token, { agentEnabled: true });
			await externalJoin(gatewayGroupId, "pu-ext-1");
			// 非自己消息 → 产生一个 agent run（无剧本 → 默认 end_turn 结束）
			await externalMessage(gatewayGroupId, "pu-ext-1", "hello agent");
			// 操作员自己发一条 → queued → sent（own 消息也进时间线）
			const sendRes = await apiReq(h, "POST", `/api/groups/${groupId}/send`, token, {
				accountId: "acc-1",
				text: "operator note",
			});
			expect(sendRes.status).toBe(202);

			// sequence + run（delaySeconds 0 → 立刻发）
			const seqRes = await apiReq(h, "POST", "/api/sequences", token, {
				name: "p2-seq",
				steps: [{ index: 1, accountRole: "admin", text: "s1", delaySeconds: 0 }],
			});
			const sequenceId = (seqRes.body as { id: string }).id;
			const runRes = await apiReq(h, "POST", `/api/groups/${groupId}/sequence-runs`, token, {
				sequenceId,
			});
			expect(runRes.status).toBe(201);
			const seqRunId = (runRes.body as { runId: string }).runId;

			// 一个建群 job（acc-3/acc-4 先上线）
			await apiReq(h, "POST", "/api/accounts/acc-3/connect", token);
			await apiReq(h, "POST", "/api/accounts/acc-4/connect", token);
			const jobRes = await apiReq(h, "POST", "/api/groups", token, {
				creatorAccountId: "acc-3",
				memberAccountIds: ["acc-4"],
			});
			expect(jobRes.status).toBe(202);
			const jobId = (jobRes.body as { jobId: string }).jobId;

			// 一个非 null 的 *Until 字段样本
			await env.pool.query(
				"UPDATE accounts SET status='rate_limited', rate_limited_until = now() + interval '1 hour' WHERE id='acc-5'",
			);

			const agentRunId = await waitLatestRunDone(h, token, groupId);
			await waitFor(async () => {
				const r = await apiReq(h, "GET", `/api/sequence-runs/${seqRunId}`, token);
				return (r.body as { status: string }).status === "finished";
			});
			await waitFor(async () => {
				const r = await apiReq(h, "GET", `/api/jobs/${jobId}`, token);
				return (r.body as { status: string }).status !== "running";
			});
			await waitFor(async () => {
				const r = await apiReq(h, "GET", `/api/groups/${groupId}/messages`, token);
				return ((r.body as { items: unknown[] }).items ?? []).length >= 2;
			});

			const endpoints = [
				"/api/health",
				"/api/auth/me",
				"/api/accounts",
				"/api/groups",
				`/api/groups/${groupId}`,
				`/api/groups/${groupId}/messages`,
				`/api/groups/${groupId}/agent-runs`,
				`/api/agent-runs/${agentRunId}`,
				"/api/sequences",
				`/api/sequences/${sequenceId}`,
				`/api/sequence-runs/${seqRunId}`,
				`/api/groups/${groupId}/sequence-runs`,
				`/api/jobs/${jobId}`,
			];
			const violations: string[] = [];
			for (const ep of endpoints) {
				const res = await apiReq(h, "GET", ep, token);
				expect(res.status, `GET ${ep}`).toBe(200);
				scanTimes(res.body, ep, violations);
			}
			// 翻一页时间线，游标后的数据也扫
			const page1 = await apiReq(
				h,
				"GET",
				`/api/groups/${groupId}/messages?limit=1`,
				token,
			);
			const nextCursor = (page1.body as { nextCursor?: string | null }).nextCursor;
			if (nextCursor) {
				const page2 = await apiReq(
					h,
					"GET",
					`/api/groups/${groupId}/messages?limit=1&before=${encodeURIComponent(nextCursor)}`,
					token,
				);
				scanTimes(page2.body, "messages[page2]", violations);
			}
			expect(violations).toEqual([]);
		} finally {
			killTracked(h);
		}
	});
});

// ---------------------------------------------------------------------------
// P3: schema 落后 → 进程退出非 0；migrate 可重复执行
// ---------------------------------------------------------------------------

function runMigrateCli(): Promise<{ code: number | null; out: string }> {
	return new Promise((resolve) => {
		const proc = spawn("npx", ["tsx", "src/db/migrate-cli.ts"], {
			cwd: SERVER_DIR,
			env: { ...process.env, DATABASE_URL: ADV_DB_URL },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		proc.stdout?.on("data", (c: Buffer) => (out += c.toString()));
		proc.stderr?.on("data", (c: Buffer) => (out += c.toString()));
		proc.on("close", (code) => resolve({ code, out }));
	});
}

describe("P3 schema version gate", () => {
	it("P3 deleting last schema_migrations row -> server exits non-zero; migrate x2 -> second is a no-op", async () => {
		const { rows: verRows } = await env.pool.query<{ v: number }>(
			"SELECT max(version) AS v FROM schema_migrations",
		);
		const maxV = verRows[0]!.v;
		const { rows: nameRows } = await env.pool.query<{ name: string }>(
			"SELECT name FROM schema_migrations WHERE version=$1",
			[maxV],
		);
		const migName = nameRows[0]!.name;
		await env.pool.query("DELETE FROM schema_migrations WHERE version=$1", [maxV]);

		let run1: { code: number | null; out: string };
		let run2: { code: number | null; out: string };
		try {
			await expect(spawnTracked()).rejects.toThrow(/server exited [1-9]/);
			run1 = await runMigrateCli();
			if (run1.code !== 0) {
				// 迁移脚本本身不可重放 → 手工把版本行补回，保证后续测试不受污染；
				// 下面仍对 run1 做严格断言（spec：迁移可重复执行）。
				await env.pool.query(
					"INSERT INTO schema_migrations (version, name) VALUES ($1, $2) ON CONFLICT DO NOTHING",
					[maxV, migName],
				);
			}
			run2 = await runMigrateCli();
		} finally {
			// 无论断言成败，schema_migrations 必须恢复完整
			await env.pool.query(
				"INSERT INTO schema_migrations (version, name) VALUES ($1, $2) ON CONFLICT DO NOTHING",
				[maxV, migName],
			);
			await migrateAdvDb();
		}
		expect(run2!.code).toBe(0);
		expect(run2!.out).toMatch(/no pending migrations/i);
		expect(run1!.code).toBe(0);
		expect(run1!.out).toMatch(new RegExp(`applied migrations:.*\\b${maxV}\\b`, "i"));
	});
});

// ---------------------------------------------------------------------------
// P4: /agent/turn 请求体符合 2.2 协议
// ---------------------------------------------------------------------------

describe("P4 agent protocol request shape", () => {
	it("P4 /agent/turn carries exactly the 4 tools, trigger ctx as messages[0], tool_result in user messages", async () => {
		const { h, token } = await boot();
		try {
			const { groupId, gatewayGroupId } = await seedGroup(h, token);
			await apiReq(h, "PATCH", `/api/groups/${groupId}`, token, { agentEnabled: true });
			await setScript([
				{ kind: "tool_use", name: "get_recent_messages", input: { limit: 10 } },
				{
					kind: "tool_use",
					name: "send_message",
					input: { text: "p4 hello", idempotency_key: "p4-k1" },
				},
				{ kind: "tool_use", name: "finish", input: { summary: "done" } },
			]);
			await externalJoin(gatewayGroupId, "pu-ext-1");
			await externalMessage(gatewayGroupId, "pu-ext-1", "question?");
			const runId = await waitLatestRunDone(h, token, groupId);

			const st = await agentState();
			const calls = st.turnCallsByRun[runId]!;
			expect(calls).toHaveLength(3);

			for (const call of calls) {
				expect(call.runId).toBe(runId);
				expect(Object.keys(call).sort()).toEqual(["messages", "runId", "tools"]);
				// tools 恰好 4 个规定名
				expect(call.tools.map((t) => t.name).sort()).toEqual([
					"finish",
					"get_recent_messages",
					"kick_user",
					"send_message",
				]);
				for (const t of call.tools) {
					expect(t.input_schema?.type).toBe("object");
					const props = Object.keys(t.input_schema?.properties ?? {});
					expect(new Set(t.input_schema?.required ?? [])).toEqual(new Set(props));
				}
				// messages[0] = user text 触发上下文
				const m0 = call.messages[0]!;
				expect(m0.role).toBe("user");
				expect(m0.content[0]!.type).toBe("text");
				const ctxJson = JSON.parse(m0.content[0]!.text!) as {
					groupId: string;
					triggerMessages: {
						msgId: string;
						senderPlatformUserId: string;
						text: string;
						sentAt: number;
					}[];
					policy: { autoKickEnabled: boolean };
					ownPlatformUserIds: string[];
				};
				expect(ctxJson.groupId).toBe(groupId);
				expect(Array.isArray(ctxJson.triggerMessages)).toBe(true);
				expect(ctxJson.triggerMessages.length).toBeGreaterThan(0);
				expect(ctxJson.triggerMessages[0]!.text).toBe("question?");
				for (let i = 1; i < ctxJson.triggerMessages.length; i++) {
					expect(ctxJson.triggerMessages[i]!.sentAt).toBeGreaterThanOrEqual(
						ctxJson.triggerMessages[i - 1]!.sentAt,
					);
				}
				expect(typeof ctxJson.policy.autoKickEnabled).toBe("boolean");
				expect(ctxJson.ownPlatformUserIds).toEqual(
					expect.arrayContaining(["pu-acc-1", "pu-acc-2"]),
				);
			}

			// 最后一个 turn 的历史里：assistant tool_use 之后必须跟 user tool_result，
			// 且 tool_use_id 对应；is_error 省略视为 false。
			const history = calls[calls.length - 1]!.messages;
			expect(history.length).toBeGreaterThanOrEqual(5); // trigger + 2×(assistant+user)
			for (let i = 1; i + 1 < history.length; i += 2) {
				const assistantMsg = history[i]!;
				expect(assistantMsg.role).toBe("assistant");
				const tu = assistantMsg.content.find((b) => b.type === "tool_use");
				expect(tu, `history[${i}] missing tool_use block`).toBeTruthy();
				const userMsg = history[i + 1]!;
				expect(userMsg.role).toBe("user");
				const tr = userMsg.content.find((b) => b.type === "tool_result");
				expect(
					tr,
					`history[${i + 1}] missing tool_result block: ${JSON.stringify(userMsg)}`,
				).toBeTruthy();
				expect(tr!.tool_use_id).toBe(tu!.id);
				expect(
					tr!.is_error !== true,
					`tool_result has is_error=true: ${JSON.stringify(tr)}`,
				).toBe(true);
				expect(typeof tr!.content).toBe("string");
				expect(() => JSON.parse(tr!.content!)).not.toThrow();
			}

			// tools 校验若失败，mock 会 400 TOOLS_INVALID → server 记 BAD_JSON。
			// run 顺利完成且无 protocol_error 步，即证明 tools 从未被拒。
			const run = await runDetail(h, token, runId);
			expect(run.status).toBe("finished");
			expect(run.steps.filter((s) => s.kind === "protocol_error")).toHaveLength(0);
			expect(
				run.steps.every((s) => !(s.rawResponse ?? "").includes("TOOLS_INVALID")),
			).toBe(true);

			// audit：send_message 前恰好一次，带 {text, groupId}
			expect(st.auditCalls).toHaveLength(1);
			expect(st.auditCalls[0]!.body).toMatchObject({
				text: "p4 hello",
				groupId,
			});
		} finally {
			killTracked(h);
		}
	});
});

// ---------------------------------------------------------------------------
// P5: BAD_JSON 全变体
// ---------------------------------------------------------------------------

describe("P5 BAD_JSON variants", () => {
	let h: ServerHandle;
	let token: string;

	beforeAll(async () => {
		({ h, token } = await boot());
	});

	afterAll(() => {
		killTracked(h);
	});

	const variants: { name: string; status?: number; body: string }[] = [
		{
			name: "HTTP 500",
			status: 500,
			body: '{"error":{"code":"AGENT_DOWN"}}',
		},
		{ name: "non-JSON text", body: "this is not json at all" },
		{
			name: "```json fenced",
			body: '```json\n{"stop_reason":"end_turn","content":[{"type":"text","text":"hi"}]}\n```',
		},
		{
			name: "JSON wrapped in prose",
			body: 'Sure! {"stop_reason":"end_turn","content":[{"type":"text","text":"hi"}]} hope that helps',
		},
		{
			name: "content has 2 blocks",
			body: '{"stop_reason":"tool_use","content":[{"type":"tool_use","id":"a","name":"finish","input":{"summary":"x"}},{"type":"tool_use","id":"b","name":"finish","input":{"summary":"y"}}]}',
		},
		{
			name: "content has 0 blocks",
			body: '{"stop_reason":"end_turn","content":[]}',
		},
		{
			name: "end_turn but block is tool_use",
			body: '{"stop_reason":"end_turn","content":[{"type":"tool_use","id":"z","name":"finish","input":{"summary":"x"}}]}',
		},
		{
			name: "stop_reason missing",
			body: '{"content":[{"type":"text","text":"hi"}]}',
		},
		{
			name: "unknown stop_reason",
			body: '{"stop_reason":"max_tokens","content":[{"type":"text","text":"hi"}]}',
		},
	];

	for (const v of variants) {
		it(`P5 ${v.name} -> protocol_error(BAD_JSON) step with rawResponse`, async () => {
			const { groupId, gatewayGroupId } = await seedGroup(h, token);
			await apiReq(h, "PATCH", `/api/groups/${groupId}`, token, { agentEnabled: true });
			await setScript([
				{ kind: "raw", status: v.status, body: v.body },
				{ kind: "end_turn", text: "recovered" },
			]);
			await externalJoin(gatewayGroupId, "pu-ext-1");
			await externalMessage(gatewayGroupId, "pu-ext-1", `trigger: ${v.name}`);
			const runId = await waitLatestRunDone(h, token, groupId);

			const run = await runDetail(h, token, runId);
			expect(
				run.status,
				`${v.name}: endReason=${run.endReason} steps=${JSON.stringify(
					run.steps.map((s) => ({ k: s.kind, e: s.errorCode })),
				)}`,
			).toBe("finished");
			const s0 = run.steps[0]!;
			expect(s0.kind).toBe("protocol_error");
			expect(s0.errorCode).toBe("BAD_JSON");
			expect(s0.isError).toBe(true);
			// 协议错误步的 toolUseId/name/input 为 null
			expect(s0.toolUseId).toBeNull();
			expect(s0.name).toBeNull();
			expect(s0.input).toBeNull();
			// rawResponse 为原始响应体（≤2KB）
			expect(s0.rawResponse).toBe(v.body);
			expect(s0.rawResponse!.length).toBeLessThanOrEqual(2048);
			// 协议错误后 run 继续并以 final 结束
			expect(run.steps[1]!.kind).toBe("final");
			expect(run.endReason).toBe("final");
		});
	}
});

// ---------------------------------------------------------------------------
// P6: tool_result ≤8KB + truncated:true；resultSummary ≤200
// ---------------------------------------------------------------------------

describe("P6 result size limits", () => {
	it("P6 get_recent_messages tool_result stays ≤8KB JSON with truncated:true; step resultSummary ≤200 chars", async () => {
		const { h, token } = await boot();
		try {
			// (a) 20 条 700 字符的外部消息（agent 关着 → 只入时间线，不触发 run）
			const { groupId, gatewayGroupId } = await seedGroup(h, token);
			await externalJoin(gatewayGroupId, "pu-ext-1");
			for (let i = 0; i < 20; i++) {
				await externalMessage(gatewayGroupId, "pu-ext-1", `m${i} ` + "x".repeat(700));
			}
			await waitFor(async () => {
				const { rows } = await env.pool.query<{ c: number }>(
					"SELECT count(*)::int AS c FROM messages WHERE group_id=$1",
					[groupId],
				);
				return rows[0]!.c >= 20;
			});
			await apiReq(h, "PATCH", `/api/groups/${groupId}`, token, { agentEnabled: true });
			// final 步的文本 300 字 → resultSummary 必须截到 ≤200
			await setScript([
				{ kind: "tool_use", name: "get_recent_messages", input: { limit: 50 } },
				{ kind: "end_turn", text: "E".repeat(300) },
			]);
			await externalMessage(gatewayGroupId, "pu-ext-1", "trigger");
			const runId = await waitLatestRunDone(h, token, groupId);

			const st = await agentState();
			const calls = st.turnCallsByRun[runId]!;
			expect(calls.length).toBeGreaterThanOrEqual(2);
			const history = calls[1]!.messages;
			const trMsg = history[history.length - 1]!;
			expect(trMsg.role).toBe("user");
			const tr = trMsg.content.find((b) => b.type === "tool_result");
			expect(tr).toBeTruthy();
			expect(Buffer.byteLength(tr!.content!, "utf8")).toBeLessThanOrEqual(8192);
			// spec：tool_result content 是 JSON 串，超限截断后仍须置 truncated:true
			const parsed = JSON.parse(tr!.content!) as {
				messages: { text: string }[];
				truncated: boolean;
			};
			expect(parsed.truncated).toBe(true);

			const run = await runDetail(h, token, runId);
			for (const s of run.steps) {
				expect(
					(s.resultSummary ?? "").length,
					`step ${s.seq} resultSummary`,
				).toBeLessThanOrEqual(200);
			}

			// (b) 单条 20KB 消息：每条 text ≤500 字 + truncated:true，总量远小于 8KB
			const g2 = await seedGroup(h, token);
			await apiReq(h, "PATCH", `/api/groups/${g2.groupId}`, token, {
				agentEnabled: true,
			});
			await setScript([
				{ kind: "tool_use", name: "get_recent_messages", input: { limit: 50 } },
				{ kind: "end_turn", text: "done" },
			]);
			const big = "B".repeat(20 * 1024);
			await externalJoin(g2.gatewayGroupId, "pu-ext-1");
			await externalMessage(g2.gatewayGroupId, "pu-ext-1", big);
			const runId2 = await waitLatestRunDone(h, token, g2.groupId);

			const st2 = await agentState();
			const history2 = st2.turnCallsByRun[runId2]![1]!.messages;
			const tr2 = history2[history2.length - 1]!.content.find(
				(b) => b.type === "tool_result",
			);
			expect(tr2).toBeTruthy();
			expect(Buffer.byteLength(tr2!.content!, "utf8")).toBeLessThanOrEqual(8192);
			const parsed2 = JSON.parse(tr2!.content!) as {
				messages: { text: string; msgId: string }[];
				truncated: boolean;
			};
			expect(parsed2.truncated).toBe(true);
			const bigMsg = parsed2.messages.find((m) => m.text.startsWith("BBB"));
			expect(bigMsg).toBeTruthy();
			expect(bigMsg!.text.length).toBe(500);
		} finally {
			killTracked(h);
		}
	});
});

// ---------------------------------------------------------------------------
// P7: activeAgentRunId / activeSequenceRunId 生命周期
// ---------------------------------------------------------------------------

describe("P7 active run ids on GET /api/groups/:id", () => {
	it("P7 activeAgentRunId set while running and null after; same for activeSequenceRunId", async () => {
		const { h, token } = await boot();
		try {
			const { groupId, gatewayGroupId } = await seedGroup(h, token);
			await apiReq(h, "PATCH", `/api/groups/${groupId}`, token, { agentEnabled: true });
			await setScript([
				{ kind: "delay", ms: 1200, then: { kind: "end_turn", text: "done" } },
			]);
			await externalJoin(gatewayGroupId, "pu-ext-1");
			await externalMessage(gatewayGroupId, "pu-ext-1", "go");

			let activeAgentRunId: string | null = null;
			await waitFor(async () => {
				const res = await apiReq(h, "GET", `/api/groups/${groupId}`, token);
				activeAgentRunId = (res.body as { activeAgentRunId: string | null })
					.activeAgentRunId;
				return activeAgentRunId !== null;
			});
			const agentRunId = activeAgentRunId!;
			// 确实是这个群的 running run
			const runList = await listRuns(h, token, groupId);
			expect(runList[0]!.id).toBe(agentRunId);
			expect(runList[0]!.status).toBe("running");

			// 序列 run 同理（admin → acc-1，member → acc-2，都在线）
			const seqRes = await apiReq(h, "POST", "/api/sequences", token, {
				name: "p7-seq",
				steps: [
					{ index: 1, accountRole: "admin", text: "s1", delaySeconds: 1 },
					{ index: 2, accountRole: "member", text: "s2", delaySeconds: 1 },
				],
			});
			const sequenceId = (seqRes.body as { id: string }).id;
			const startRes = await apiReq(
				h,
				"POST",
				`/api/groups/${groupId}/sequence-runs`,
				token,
				{ sequenceId },
			);
			expect(startRes.status).toBe(201);
			const seqRunId = (startRes.body as { runId: string }).runId;
			await waitFor(async () => {
				const res = await apiReq(h, "GET", `/api/groups/${groupId}`, token);
				return (
					(res.body as { activeSequenceRunId: string | null })
						.activeSequenceRunId === seqRunId
				);
			});

			await waitFor(async () => {
				const r = await runDetail(h, token, agentRunId);
				return r.status === "finished";
			});
			await waitFor(async () => {
				const r = await apiReq(h, "GET", `/api/sequence-runs/${seqRunId}`, token);
				return ["finished", "failed", "stopped"].includes(
					(r.body as { status: string }).status,
				);
			}, 20_000);
			const fin = await apiReq(h, "GET", `/api/groups/${groupId}`, token);
			expect((fin.body as { activeAgentRunId: unknown }).activeAgentRunId).toBeNull();
			expect(
				(fin.body as { activeSequenceRunId: unknown }).activeSequenceRunId,
			).toBeNull();
		} catch (err) {
			dumpServer(h, "P7"); // fetch failed 等失联场景下留下 stderr 证据
			throw err;
		} finally {
			killTracked(h);
		}
	});
});
