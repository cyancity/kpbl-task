# 多账号群组消息平台

后端 Node.js + TypeScript + PostgreSQL，前端 React 18 + TypeScript。对接一个"故意不可靠"的消息网关（HTTP + SSE）和一个"故意不守规矩"的 Agent 服务，在不可靠依赖之上提供账号状态机、出站 exactly-once 语义、建群/退群编排、Agent 工具调用协议、定时序列和实时控制台。

## 架构

```
apps/
  server/        Node + TS + Fastify + pg（原生 SQL，自写 migrate runner）
  web/           React 18 + Vite + TS（TanStack Query + 原生 WS）
  mock-gateway/  可注入故障的网关模拟器（HTTP + SSE），/__admin 注入 429/504/坏行为
  mock-agent/    可编排脚本的 Agent 模拟器（/agent/turn, /agent/audit），/__admin 设置剧本
packages/
  shared/        共享类型、错误码、账号转移表
```

### 后端核心机制

- **一切异步工作都是 DB 里的行**：`messages`（出站 outbox）、`jobs`、`agent_runs`+`agent_steps`、`sequence_runs`+`sequence_run_steps`、`ws_events`、`gateway_events`。
- **Worker 循环**（200–250ms tick，`FOR UPDATE SKIP LOCKED` + lease 领取）：sender、rate-limit-expiry、job-runner、agent-runner、sequence-scheduler、unknown-reconciler。多实例安全。
- **SSE 事件消费者**：持久化水位游标（连续无洞最大 eventId，回看 2s 吸收乱序）；每个事件事务内处理：插 `gateway_events`（唯一约束去重）→ 业务处理 → 写 `ws_events`；失败写 `dead_events` + `inconsistency`。
- **WS 推送器**：轮询 `ws_events` 新 seq 广播给已认证连接，`sinceSeq` 补发断线期间事件。
- 详见 [docs/PLAN.md](docs/PLAN.md)。

## 快速开始

前置：Node ≥ 20（建议 24）、PostgreSQL 16（brew 或 docker）。

```bash
createdb gmp_dev
cp .env.example apps/server/.env   # 或直接 export；server 读 process.env
npm i
npm run dev        # 先跑 migrate，再用 concurrently 启动全部 4 个进程
```

| 进程          | 端口 | 说明                          |
| ------------- | ---- | ----------------------------- |
| web (Vite)    | 5173 | 控制台 UI，/api、/ws 代理到 server |
| server        | 3000 | Fastify API + WS + 全部 worker |
| mock-gateway  | 4000 | 网关模拟器                    |
| mock-agent    | 4100 | Agent 模拟器                  |

默认账号：`admin/admin`（管理员，可操作）、`viewer/viewer`（只读，所有写操作隐藏）。

### 环境变量（apps/server）

| 变量                     | 默认                          | 说明                     |
| ------------------------ | ----------------------------- | ------------------------ |
| `PORT`                   | 3000                          | API 端口                 |
| `DATABASE_URL`           | —                             | 业务库                   |
| `TEST_DATABASE_URL`      | —                             | 测试库                   |
| `GATEWAY_URL`            | http://localhost:4000         | 网关地址                 |
| `AGENT_URL`              | http://localhost:4100         | Agent 地址               |
| `JWT_SECRET`             | —                             | access token 签名        |
| `AGENT_TURN_TIMEOUT_MS`  | 12000                         | /agent/turn 超时         |
| `JOIN_TIMEOUT_MS`        | 10000                         | 建群等 member_joined 上限 |

## 演示脚本（用 mock admin API 复现 S1–S8）

先登录拿 token，连接账号并建群（`seedGroup` 对应的真实流程：connect → POST /api/groups → 等 job finished）。

```bash
TOKEN=$(curl -s localhost:3000/api/auth/login -H 'content-type: application/json' \
  -d '{"username":"admin","password":"admin"}' | jq -r .accessToken)
AUTH="authorization: bearer $TOKEN"

# 连接账号并建群（acc-1 群主，acc-2/acc-3 成员）
for a in acc-1 acc-2 acc-3; do curl -s -X POST localhost:3000/api/accounts/$a/connect -H "$AUTH"; done
curl -s -X POST localhost:3000/api/groups -H "$AUTH" -H 'content-type: application/json' \
  -d '{"creatorAccountId":"acc-1","memberAccountIds":["acc-2","acc-3"]}'
# → {jobId, groupId}，轮询 GET /api/jobs/:jobId 直到 finished

# S1 普通发送（202 → queued → accepted → sent，sentAt 来自网关）
curl -s -X POST localhost:3000/api/groups/$GID/send -H "$AUTH" \
  -H 'content-type: application/json' -d '{"accountId":"acc-1","text":"hello"}'

# S4 限流：给 acc-1 注入一次 429（retryAfter 2s），期间消息排队，到期按 FIFO 补发
curl -s -X POST localhost:4000/__admin/accounts/acc-1/inject \
  -H 'content-type: application/json' -d '{"code":"RATE_LIMITED","retryAfterSeconds":2,"once":true}'

# S5 网关 504：返回超时但其实 1.5s 后落地 → 不得重发，网关只有一条
curl -s -X POST localhost:4000/__admin/accounts/acc-1/inject \
  -H 'content-type: application/json' \
  -d '{"code":"NETWORK_TIMEOUT","actuallyDelivered":true,"landDelayMs":1500,"once":true}'
curl -s localhost:4000/__admin/state | jq '.messages'   # 验证只有一条

# S2 乱序/重复事件：外部消息注入，消息到达后群 timeline 去重排序
curl -s -X POST localhost:4000/__admin/groups/$GWGID/external-message \
  -H 'content-type: application/json' -d '{"platformUserId":"pu-ext","text":"hi"}'

# S6 协议错误：给 mock-agent 配剧本（fenced JSON → 被当 BAD_JSON 记 protocol_error）
curl -s -X POST localhost:4100/__admin/script -H 'content-type: application/json' -d '{
  "runs":{"*":[{"kind":"raw","body":"```json\n{\"stop_reason\":\"end_turn\",\"content\":[{\"type\":\"text\",\"text\":\"hi\"}]}\n```"},
               {"kind":"end_turn","text":"done"}]}}'
# 群 PATCH agentEnabled=true 后再发一条外部消息即可看到 run

# S7 并发启动同一序列 → 一个 201、一个 409 SEQUENCE_ALREADY_RUNNING（DB 部分唯一索引）

# S8 预检：文本含未提供变量 → 422 UNRESOLVED_PLACEHOLDER 带 stepIndex+key，零发送
curl -s -X POST localhost:3000/api/sequences/$SEQID/resolve -H "$AUTH" \
  -H 'content-type: application/json' -d '{"vars":{}}'

# 群级写禁言 → 群 unreachable、序列 stopped
curl -s -X POST localhost:4000/__admin/groups/$GWGID/inject \
  -H 'content-type: application/json' -d '{"code":"GROUP_WRITE_FORBIDDEN"}'

# 账号封号（同步错误或事件均可）→ 终态级联：移出群、queued 取消、序列步骤 skipped
curl -s -X POST localhost:3000/api/accounts/acc-1/transition -H "$AUTH" \
  -H 'content-type: application/json' -d '{"to":"suspended","expectedFrom":"online"}'
```

查看 mock 状态：`GET localhost:4000/__admin/state`、`GET localhost:4100/__admin/state`；重置：`POST /__admin/reset`。

## 测试

```bash
createdb gmp_test
TEST_DATABASE_URL=postgres://localhost:5432/gmp_test npm test
npm run typecheck && npm run lint
npm run build        # 构建全部 workspace
```

测试库由 `truncateAll` 在每个用例间清空；mock-gateway / mock-agent 在进程内以随机端口启动。

## 设计要点

- **出站 exactly-once**：先落 `queued`（预生成 clientMsgId）提交，worker 领取置 `sending` 再调���关；504 → `unknown`，只有 `by-client-id` 在 504 后满 2s 仍 404 才允许**一次**重发（`resend_count` 约束）；`sending` 超时自动转 unknown 走同一对账。
- **限流**：429 → `rate_limited` + `rateLimitedUntil`（retryAfter），限流期间该账号一律不发（连一次探针都会刷新计时）；到期 worker CAS 回 `online`，序列步骤顺延不跳过。
- **账号 CAS**：`expectedFrom` 乐观并发；终态转移在同一事务内完成移群、取消队列、跳步、写事件。同步错误、事件、操作员三条路径共用 `transitionAccount`。
- **Agent 协议**：历史、计数、executing 步骤全部落库；副作用步骤先写 `executing` 提交再执行，崩溃恢复只定决不重放；12 步/60s/3 连协议错误三重上限；run 内 idempotency_key 映射 clientMsgId；审计 3 次不定 → blocked。
- **序列**：变量 `vars` 默认 + `stepVars` 逐步覆盖（`""` 各有语义），启动时冻结解析结果；部分唯一索引保证单群单 running；重启检测（last_tick_at >5s + 当前步逾期 >1s）按该步 delay 重排。
- **WS**：事件先入库（BIGSERIAL seq）再推，断线 `sinceSeq` 补发、seq 去重。

## 未做

- **C1**（多实例水平扩展演示）：机制已就绪（SKIP LOCKED、部分唯一索引、无内存状态），未做两实例联调演示。
- **C2**（媒体消息）：mock 与 schema 支持 `mediaUrl` 透传，UI 未做上传/展示。
- **C3**（前端 e2e）：有 `apps/web` 的 vitest 单测（api client 单飞 refresh、错误包络），未做 Playwright 冒烟。
