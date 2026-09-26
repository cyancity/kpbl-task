import { expect, test, type WebSocketRoute } from "@playwright/test";
import {
  adminToken,
  apiGet,
  apiPatch,
  createGroup,
  expiredAccessToken,
  externalMessage,
  resetAgent,
  setAgentScript,
  uiLogin,
  waitFor,
  waitForNoRunningAgentRuns,
  type AgentRunItem,
} from "./helpers";

/**
 * docs/TEST_PLAN.md F 节 —— Playwright 冒烟（C3 的完整版）。
 * 全部跑在外层会话的 dev stack 上（web :5173 / server :3000 / mocks :4000、:4100）。
 * UI 能走的路走 UI（登录、连账号、建群、开关）；mock admin 只用来造剧本与外部事件。
 */
// 不配 serial describe：workers=1 已保证串行，且 serial 模式会让前一条失败跳过后续用例。
// 各用例自带独立造数（新群）与 mock 剧本清理（finally reset），互不依赖。

test("F1 viewer 登录：只读视图无任何写入口", async ({ page }) => {
  const token = await adminToken();
  const group = await createGroup(token, "acc-1", ["acc-6"]);
  await apiPatch(token, `/api/groups/${group.id}`, { agentEnabled: true });

  try {
    // 让 run 在 ~24s 内保持 running：两个 30s 的 turn 延迟各触发一次 TURN_TIMEOUT，
    // 之后剧本耗尽、mock 默认 end_turn 结束 run。viewer 在这个窗口里检查「取消」按钮。
    // 先等全局没有 running 的 run：剧本是共享队列，会被别的 run 吃掉
    await waitForNoRunningAgentRuns(token);
    await setAgentScript([
      { kind: "delay", ms: 30_000, then: { kind: "end_turn", text: "f1" } },
      { kind: "delay", ms: 30_000, then: { kind: "end_turn", text: "f1" } },
    ]);
    await externalMessage(group.gatewayGroupId!, "pu-ext-f1", `f1-probe-${Date.now()}`);
    const runningRun = await waitFor(async () => {
      const runs = await apiGet<AgentRunItem[]>(token, `/api/groups/${group.id}/agent-runs`);
      return runs.find((r) => r.status === "running") ?? null;
    });

    await uiLogin(page, "viewer", "viewer");
    await expect(page.locator(".user")).toContainText("viewer（viewer）");

    // 账号页：只读表格，无「重连/标记离线/释放账号」，连「操作」列都没有
    await page.goto("/accounts");
    await expect(page.locator("tbody tr").first()).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "操作" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "重连" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "标记离线" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "释放账号" })).toHaveCount(0);

    // 群详情：成员/时间线/Agent 运行列表可读，写控件全部隐藏
    await page.goto(`/groups/${group.id}`);
    await expect(page.locator(".timeline")).toBeVisible();
    await expect(page.getByPlaceholder("消息内容")).toHaveCount(0); // 发送框
    await expect(page.getByRole("button", { name: "发送" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "全部退群" })).toHaveCount(0);
    await expect(page.locator("label.inline")).toHaveCount(0); // agentEnabled / autoKickEnabled 开关
    await expect(page.getByRole("button", { name: "启动" })).toHaveCount(0); // 序列面板不渲染
    await expect(page.getByRole("button", { name: "预检" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "新建序列" })).toHaveCount(0);

    // Agent 运行详情：run 仍在 running，但 viewer 看不到「取消」
    await page.goto(`/agent-runs/${runningRun.id}`);
    await expect(page.locator(".card .badge").first()).toHaveText("running");
    await expect(page.getByRole("button", { name: "取消" })).toHaveCount(0);
  } finally {
    await resetAgent();
  }
});

test("F2 admin：连账号→建群→开 agent→外部消息→run 详情含 protocol_error 步", async ({ page }) => {
  const token = await adminToken();
  await uiLogin(page, "admin", "admin");
  await expect(page.locator(".user")).toContainText("admin（admin）");

  // 账号页：用 UI 把 acc-4 / acc-5 connect 上线（已在线则跳过，保证用例幂等）
  await page.goto("/accounts");
  for (const id of ["acc-4", "acc-5"]) {
    const row = page.locator("tbody tr", { hasText: id });
    await expect(row).toBeVisible();
    const reconnect = row.getByRole("button", { name: "重连" });
    if ((await reconnect.count()) > 0) await reconnect.click();
    await expect(row.locator(".badge")).toHaveText("在线", { timeout: 10_000 });
  }

  // 群组页：UI 建群（群主 acc-4，成员 acc-5），等 create_group job 跑完
  // 注意：<option> 元素永远是 hidden，只能等 attached；selectOption 自带等待
  await page.goto("/groups");
  await page.locator("select option[value='acc-4']").waitFor({ state: "attached" });
  await page.locator("select").selectOption("acc-4");
  await page.locator("fieldset label", { hasText: "acc-5" }).locator("input").check();
  await page.getByRole("button", { name: "创建" }).click();
  await expect(page.locator(".job-status")).toContainText("finished", { timeout: 20_000 });

  // 找出刚建好的群（acc-4 为群主的最后一个），进详情打开 agentEnabled
  const group = await waitFor(async () => {
    const groups = await apiGet<{ id: string; creatorAccountId: string; status: string }[]>(
      token,
      "/api/groups",
    );
    return groups.filter((g) => g.creatorAccountId === "acc-4" && g.status === "active").at(-1);
  });
  await page.goto(`/groups/${group.id}`);
  const agentToggle = page.locator("label.inline", { hasText: "agentEnabled" }).locator("input");
  await agentToggle.click();
  await expect(agentToggle).toBeChecked();

  // mock-agent 剧本：第 1 轮回非法 body（→ protocol_error 步），第 2 轮正常调工具，第 3 轮结束。
  // 先等全局静默：F1 留下的 delay 剧本 run 可能还在跑，会偷吃 "*" 剧本的步
  const marker = `f2-bad-${Date.now()}`;
  try {
    await waitForNoRunningAgentRuns(token);
    await setAgentScript([
      { kind: "raw", body: `GARBAGE-${marker}-不是合法JSON` },
      { kind: "tool_use", name: "get_recent_messages", input: { limit: 5 } },
      { kind: "end_turn", text: "f2 done" },
    ]);
    const detail = await apiGet<{ gatewayGroupId: string }>(token, `/api/groups/${group.id}`);
    await externalMessage(detail.gatewayGroupId, "pu-ext-f2", `f2-trigger-${marker}`);

    // 群详情：Agent 运行表出现 run 行，点进去
    const runLink = page.locator("a[href^='/agent-runs/']").first();
    await expect(runLink).toBeVisible({ timeout: 15_000 });
    await runLink.click();
    await expect(page).toHaveURL(/\/agent-runs\/[0-9a-f-]+/);

    // 详情页：等 run 收敛（running 时每秒轮询），随后校验步骤表
    await expect(page.locator(".card .badge").first()).toHaveText(/finished|failed|blocked/, {
      timeout: 20_000,
    });
    const errRow = page.locator("tbody tr", { hasText: "protocol_error" });
    await expect(errRow).toHaveCount(1);
    await expect(errRow).toContainText("BAD_JSON");
    await expect(page.locator("tbody tr", { hasText: "get_recent_messages" })).toHaveCount(1);
    await expect(page.locator("tbody tr", { hasText: "final" })).toHaveCount(1);

    // protocol_error 步可展开 rawResponse，内容就是 mock 回的原始体
    await errRow.getByRole("button", { name: "查看原始响应" }).click();
    await expect(page.locator("pre.raw")).toContainText(`GARBAGE-${marker}`);
  } finally {
    await resetAgent();
  }
});

test("F3 WS 断线补齐：服务端强制断开期间的事件，重连后 3s 内上屏且不重复", async ({ page }) => {
  const token = await adminToken();
  // agentEnabled 保持 false：本用例只关心时间线补齐，不需要 agent 介入
  const group = await createGroup(token, "acc-6", ["acc-5"]);
  const gwGroupId = group.gatewayGroupId!;

  // 接管页面 WS：记录每条连接的 server 端句柄与 auth 成功时间，用来「服务端强断」
  interface Conn {
    server: WebSocketRoute;
    openedAt: number;
    authOkAt: number | null;
  }
  const conns: Conn[] = [];
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const conn: Conn = { server: ws.connectToServer(), openedAt: Date.now(), authOkAt: null };
    conns.push(conn);
    ws.onMessage((m) => conn.server.send(m));
    conn.server.onMessage((m) => {
      try {
        const p = JSON.parse(typeof m === "string" ? m : m.toString("utf8")) as {
          type?: string;
          success?: boolean;
        };
        if (p.type === "auth" && p.success) conn.authOkAt = Date.now();
      } catch {
        /* 非 JSON 帧忽略 */
      }
      ws.send(m);
    });
  });

  await uiLogin(page, "viewer", "viewer");
  // 注意：page.goto 是整页刷新，每次跳转都会新建一条 WS 连接——盯最后一条
  await page.goto(`/groups/${group.id}`);
  await expect(page.locator(".timeline")).toBeVisible();
  await waitFor(async () => (conns.at(-1)?.authOkAt ? true : null));

  // 服务端方向断开 → 客户端 onclose → 自动重连（首次退避 ~300ms）。
  // 断线窗口内向网关注入 5 条外部消息：服务端照常消费 SSE 事件、写 ws_events，
  // 页面只能等重连后靠 sinceSeq 补齐。
  const beforeClose = conns.length;
  await conns.at(-1)!.server.close();
  const tag = `f3-${Date.now()}`;
  const texts = Array.from({ length: 5 }, (_, i) => `${tag}-${i}`);
  await Promise.all(texts.map((t) => externalMessage(gwGroupId, "pu-ext-f3", t)));
  const injectedDuringGap = conns.length === beforeClose; // 注入完成时是否仍未重连（供报告参考）

  await waitFor(async () => (conns.length > beforeClose ? true : null), 10_000);
  const reopened = conns.at(-1)!;
  await waitFor(async () => (reopened.authOkAt ? true : null), 10_000);
  const deadline = reopened.authOkAt! + 3_000; // spec: 重连后 3 秒内出现在页面上

  const timings: Record<string, number> = {};
  for (const t of texts) {
    const loc = page.locator(".msg").filter({ hasText: t });
    await expect(loc).toHaveCount(1, { timeout: Math.max(1, deadline - Date.now()) });
    timings[t] = Date.now() - reopened.authOkAt!;
  }
  const report = { injectedDuringGap, msAfterReconnect: timings };
  console.log("[F3 timing]", JSON.stringify(report));
  await test.info().attach("f3-timing", {
    body: JSON.stringify(report, null, 2),
    contentType: "application/json",
  });
});

test("F4 access token 过期：并发 401 只触发一次 /api/auth/refresh", async ({ page }) => {
  const token = await adminToken();
  const group = await createGroup(token, "acc-1", ["acc-5"]);

  await uiLogin(page, "admin", "admin");
  const realToken = await page.evaluate(() => sessionStorage.getItem("gmp_access_token"));
  expect(realToken).toBeTruthy();
  const expired = expiredAccessToken(realToken!);

  // 拖慢 refresh 300ms：确保并发的 401 全部撞上同一个 refreshPromise。
  let refreshCalls = 0;
  await page.route("**/api/auth/refresh", async (route) => {
    refreshCalls += 1;
    await new Promise((r) => setTimeout(r, 300));
    await route.continue();
  });

  // 换成过期 token 后整页刷新：模块重新从 sessionStorage 读 token；
  // 群详情页挂载时并发发出 4 个查询（group/accounts/agent-runs/sequence-runs），全部 401。
  await page.evaluate((t) => sessionStorage.setItem("gmp_access_token", t), expired);
  await page.goto(`/groups/${group.id}`);

  // 页面自愈：token 刷新后重放查询，群详情正常渲染（未跳回登录页）
  await expect(page.locator("h1")).toContainText("群组", { timeout: 15_000 });
  await expect(page.locator("h3", { hasText: "成员" })).toBeVisible();
  expect(refreshCalls).toBe(1);

  // sessionStorage 里已是 refresh 换出的新 token
  const stored = await page.evaluate(() => sessionStorage.getItem("gmp_access_token"));
  expect(stored).toBeTruthy();
  expect(stored).not.toBe(expired);
});
