# 题目分析与开发计划

题目：多账号群组消息平台（后端 Node+TS+PG，前端 React18+TS），对接一个"故意不可靠"的消息网关（HTTP+SSE）和一个"故意不守规矩"的 Agent 服务。

## 1. 核心考察点

| #   | 考察点                                                | 对应条目           | 本质                                                                             |
| --- | ----------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------- |
| K1  | **at-least-once + 乱序 + 补投** 的事件流消费          | 2.1 事件流, A2, S2 | 幂等消费、游标水位、按业务键去重                                                 |
| K2  | **出站消息 exactly-once 语义**（网关本身不去重）      | A2, S1, S5         | outbox 模式：先落库再调网关；504 之后"先确认未发出、再且仅重发一次"              |
| K3  | **账号状态机 + CAS + 终态原子副作用**                 | A1                 | 转移表、乐观并发、一个事务内完成级联（移群、取消队列、跳步、事件）               |
| K4  | **有限状态下的限流队列**                              | A1/A2/S4           | 每账号 FIFO，rate_limited 期间不下发；序列顺延不跳过                             |
| K5  | **崩溃一致性 / 任意时刻重启**                         | 总则, A5.8, B1     | 所有异步进程（job、发送、agent run、序列）状态机全部落库，进程无状态，靠 DB 恢复 |
| K6  | **Agent tool-use 协议实现 + 防御**                    | A5, 2.2, S6        | 校验响应形状、步数/时钟/连续协议错误三重上限、审计、幂等 key、恢复不重放副作用   |
| K7  | **多实例互斥**（同群唯一 running run / sequence run） | A5.1, B1, S7       | DB 唯一部分索引，不靠内存锁                                                      |
| K8  | **游标分页与实时写入并存**                            | A4                 | keyset 分页而非 offset                                                           |
| K9  | **实时推送与持久化状态一致**                          | A1, 2.3 WS         | 事件先入库（带 seq）再推，sinceSeq 补发                                          |
| K10 | **会话安全**                                          | B3                 | refresh 轮换 + reuse 检测作废整个 family；logout 使 access 立即失效              |
| K11 | **异步编排（建群 / leave-all）的部分失败处理**        | A3, B2             | 每步错误记录、有限重试、最终与网关成员列表一致                                   |
| K12 | **变量解析规则**                                      | B1                 | 逐步覆盖、`""` 语义、来源标注、预检不留痕                                        |

## 2. 陷阱清单（以及我们的对策）

### 事件流

- **T1 游标不能简单取 max(eventId)**：乱序窗口 ≤1s，先收到 105 再收到 104；若把游标推进到 105 并断线，104 永久丢失。对策：每个 eventId 落 `gateway_events` 表（唯一约束），持久化游标 = "已处理集合中连续无洞的最大 id"（水位），最多回看 2s；重复由唯一约束吸收。
- **T2 补投事件 sentAt 可比已收消息早任意时长**：不能用 sentAt 判断"过期"，也不能假设新事件 sentAt 单调。时间线严格按 (sentAt, msgId) 排序，不用插入顺序。
- **T3 own 消息回流**：`message` 事件里包含自己发的消息；必须以 `(groupId,msgId)` 合并到已有出站行（通过 `message_sent` 已知 msgId），不得再插一行，不得触发 agent。顺序不确定：`message` 事件可能先于 `message_sent` 到达 → 此时按 senderPlatformUserId ∈ 自己账号集合 判 isOwn 并先占行，随后 `message_sent` 按 msgId 合并 clientMsgId。
- **T4 事件处理中 DB 写失败**：不能中断消费、不能丢内容 → 把原始事件写入 `dead_events`（独立连接/重试）+ 推 `inconsistency`，游标不跨过它（或写入后再跨）。
- **T5 事件流从网关启动起就推**：与 connect 无关，服务启动就要开消费，且 `since` 从持久化游标恢复；首次启动无游标则不带 since（从当前开始）—— 但为了"停机期间事件都要处理到"，首次启动就要立刻持久化第一个 eventId。
- **T6 account_status 事件 suspended/session_expired 可能重复推、也可能根本不推**（同步错误里已进入终态）→ 终态转移幂等、静默忽略重复。

### 出站发送

- **T7 先调网关再落库 = 崩溃后网关有、DB 没有**。必须先写 `queued` 行（生成 clientMsgId）并提交，再由 worker 领取发送；worker 领取时先把状态改为 `sending`（记录 attempt 时间）再调网关，崩溃后 `sending` 行恢复为 `unknown` 走 by-client-id 对账，绝不盲目重发。
- **T8 504 处理时序**：504 → `unknown`；网关承诺 2s 内落地。策略：t=0 记 504；轮询 by-client-id；若 `200` → accepted/sent；若 t≥2s 仍 `404` → 判定未发出 → 允许**一次**重发（resend_count 唯一约束 ≤1）；重发再 504 且 2s 后仍 404 → `failed(NETWORK_TIMEOUT)`。总时长 <5s。by-client-id 503 → 保持 unknown，恢复后 2s 内定论（不能在 503 期间重发）。
- **T9 网关不去重**：同一 clientMsgId 只能出现在网关里一条，重发只允许在"确认未落地"后。S5 场景专门考这个：agent 用同一 idempotency_key 再调 → 我们在 run 内 key→clientMsgId 映射，直接返回状态。
- **T10 429 计时重置**：限流期内任何 send 会刷新计时，所以限流期间**一次都不能**再发（包括其他排队消息、序列步骤、agent send）。仅 disconnect/leave 不受限。
- **T11 429 到期恢复**：定时器到期时账号可能已被标记 disconnected → 只有 `rate_limited → online` 时才转。用 DB 状态 CAS 而非内存定时器（重启后靠 `rateLimitedUntil` 扫描恢复）。
- **T12 GROUP_WRITE_FORBIDDEN 是群级别**：群 → unreachable，序列 → stopped，agent 当前步后 cancelled，**账号不变**；且 `message_failed` 事件里的同名 code 也要同样处理。

### 账号状态

- **T13 同状态转移非法**、终态无出边（重连不能恢复）；`rateLimitedUntil` 刷新不是转移；`expectedFrom` 必填做 CAS，`UPDATE ... WHERE status = expectedFrom` 影响 0 行 → 需区分 404 / CAS_CONFLICT。
- **T14 终态副作用原子性**：同一事务：改状态、删所有 group_members、queued→cancelled(ACCOUNT_TERMINAL)、关联序列步骤→skipped、写 ws_events(account_status_changed + account_terminal)。三种来源（发送错误、事件、操作员）共用同一函数。
- **T15 WS 事件必须对应已保存状态** → 事件在同一事务写 `ws_events` 表（seq 用 BIGSERIAL），提交后由推送器发送；不在提交前 emit。

### 建群 / 退群

- **T16 创建者不推 member_joined**、其他成员入群以事件为准，可能永远不来 → 10s JOIN_TIMEOUT。
- **T17 promote 总调用 ≤2**：NOT_MEMBER_YET 说明事件还没到，等 member_joined 落库后再 promote（最多重试一次）。
- **T18 INVITE_EXPIRED 只重申请一次；ALREADY_MEMBER 视为成功且不会来事件** → 直接写成员并 promote。
- **T19 kick 504 结果未知** → 2s 后查 members 收敛。
- **T20 leave-all 顺序**：非群主先退（失败记录、继续），群主最后；有失败则群主不退、job failed；成功后 members=[]、status=left；最后与网关 `GET members` 对账。

### Agent

- **T21 单群单 running run 多实例成立** → `UNIQUE (group_id) WHERE status='running'` 部分索引；触发时插入失败则把消息放进 `agent_pending_messages`。run 结束事务内检查 pending 并立即创建下一 run（同事务，避免竞态丢消息）。
- **T22 protocol_error 两种历史追加方式**：UNKNOWN_TOOL/INVALID_INPUT 追加 assistant tool_use + is_error tool_result；BAD_JSON/DUPLICATE_TOOL_USE_ID/TURN_TIMEOUT 不追加 assistant 块，追加 user text `PROTOCOL_ERROR <code>: ...`。BAD_JSON 定义含：非 2xx、非 JSON、围栏、多块、stop_reason 与块类型不一致。
- **T23 三种上限**：12 步含结束步；60s 从创建起累计**排除停机**（存 `elapsedMsBeforeRestart` + `resumedAt`）；连续 3 次协议错误（合法响应清零）。审计重试计时不计步。
- **T24 turn 超时后迟到的响应丢弃** → 每次调用带 attempt id，落库前比对。
- **T25 审计**：只有 `verdict === 'pass'` 才执行；`fail` → AUDIT_REJECTED 不消耗 idempotency key；非明确结论最多 3 次 → blocked。
- **T26 副作用不可重放**：执行 send/kick 前先写 step 行（状态 executing，含 clientMsgId），崩溃恢复时看到 executing 步：send → 查 outbox 行状态；kick → 查网关 members；再补写 tool_result，绝不重执行。
- **T27 get_recent_messages 重复调用**：同入参连续第 2 次返回同样结果 + hint，第 3 次起返回 `is_error INVALID_INPUT`（hint: 请 finish）以逼近 12 步内结束。limit>50 按 50，text>500 截断。
- **T28 执行账号选择**：send 用 online 成员（优先非 rate_limited）；kick 需 creator/admin；autoKickEnabled=false → POLICY_DENIED（在审计之前判断，避免无谓审计）。
- **T29 外部状态变化**：每步结束后检查群 unreachable / agentEnabled=false → cancelled。

### 序列

- **T30 变量语义**：`vars` 中 `""` = 未提供；`stepVars` 中 `""` = 不改；step 覆盖向后延续；varSources 标最初给出的那一步。预检失败 422 不留任何 run 记录（先算再插）。
- **T31 排期锚点是 message_sent 时刻**（不是受理时刻）；skipped 步的"发出时刻"= 跳过时刻。
- **T32 重启重排**：只重排最早一个已过期步骤为 `now + delaySeconds`，后续仍链式。
- **T33 rate_limited 账号不算"没有账号"** → 顺延；没有匹配账号 → skipped。

### 鉴权 / WS / 基础

- **T34 refresh reuse 检测**：token family；旧 token 再用 → 401 且整 family 作废，同时**access token 也失效** → access token 需携带 sessionId，请求时校验 session 未作废（内存 LRU + DB）。logout 同理。
- **T35 前端多请求同时 401 只 refresh 一次** → 单例 promise。
- **T36 schema 落后拒绝启动**：`schema_migrations` 表版本 < 代码期望版本 → 退出非 0。
- **T37 错误格式统一** `{ error: { code, message, requestId, ... } }`，401 UNAUTHORIZED、403 FORBIDDEN。
- **T38 keyset 分页**：cursor = base64(sentAt, msgId/clientMsgId)。注意 own 消息 sentAt 在 message_sent 后会变（受理时刻 → 网关时刻），而 message_sent 只在最近几秒内到达、位于时间线头部，"加载更早"只向旧方向翻页，不受影响。

## 3. 架构

```
apps/
  server/        Node 20 + TS + Fastify + pg（原生 SQL，node-pg-migrate 风格自写 runner）
  web/           React 18 + Vite + TS（TanStack Query + 原生 WS）
  mock-gateway/  可注入故障的网关模拟器（HTTP + SSE），支持 /__admin 注入 429/504/坏行为
  mock-agent/    可编排脚本的 Agent 模拟器（/agent/turn, /agent/audit），支持 /__admin 设置剧本
packages/
  shared/        类型与错误码
```

### 后端核心机制

- **一切异步工作都是 DB 里的行**：`outbox_messages`（发送）、`jobs`（建群/退群）、`agent_runs`+`agent_steps`、`sequence_runs`+`sequence_run_steps`、`ws_events`、`gateway_events`。
- **Worker 循环**（每 200ms tick，`FOR UPDATE SKIP LOCKED` 领取）：sender、rate-limit-expiry、job-runner、agent-runner、sequence-scheduler、unknown-reconciler。多实例安全。
- **事件消费者**：SSE 客户端，持久化游标水位；每个事件在事务内处理：插 gateway_events（冲突即重复 → 跳过）→ 业务处理 → 写 ws_events。失败 → dead_events + inconsistency。
- **WS 推送器**：LISTEN/NOTIFY 或轮询 ws_events 新 seq，广播给已认证连接；`sinceSeq` 补发。

## 4. 开发阶段（含验收标准）

| 阶段 | 内容                                                                                                                       | 验收                                                                                         |
| ---- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| P1   | 骨架、迁移、health/schemaVersion、auth（login/refresh/logout/viewer 403）、账号 CRUD/transition/connect、mock-gateway 基础 | 单测：状态机转移表全覆盖、CAS、终态级联                                                      |
| P2   | outbox 发送、限流、504 对账、事件消费（去重/乱序/水位/补投/own 回流/dead_events）、时间线分页、WS                          | 集成测试 S1–S4、重启恢复                                                                     |
| P3   | 建群 job、leave-all、B2 全部错误分支                                                                                       | 集成测试：INVITE_NOT_READY/EXPIRED、ALREADY_MEMBER、JOIN_TIMEOUT、promote ≤2、leave 部分失败 |
| P4   | Agent run 引擎 + mock-agent 剧本                                                                                           | S5、S6、审计 blocked、幂等、恢复、12 步/60s/3 连错、cancelled                                |
| P5   | 序列                                                                                                                       | S7、S8、变量来源、排期、重启重排                                                             |
| P6   | 前端 5 页 + refresh 单飞 + 断线补齐                                                                                        | 手工 + Playwright 冒烟                                                                       |
| P7   | 对抗性测试（混沌注入）、修复、README                                                                                       | 全部测试绿；`docs/TEST_PLAN.md` 用例逐条勾选                                                 |

C 组：C3（Playwright 冒烟）随 P6 顺带；C1/C2 不做。

## 5. 开发目标（本次交付定义）

1. A 组全部 + B 组全部实现，在 mock 网关/mock agent 的故障注入下通过 S1–S8。
2. 任意时刻 `kill -9` 服务后重启，进行中的发送 / job / agent run / 序列都正确恢复（有自动化测试）。
3. 前端 5 个页面可用；viewer 无写按钮且写接口 403。
4. `docker-compose`（或 `brew services`）+ `npm run dev` 一条命令起全部；README 描述完整。
5. git 历史按阶段提交。
