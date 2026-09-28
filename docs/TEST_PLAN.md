# 对抗性验证用例清单

> 目的：以"故意找茬"的方式验证 PLAN.md 中列出的陷阱 T1–T38 是否真的被覆盖。
> 每条用例要么由 `apps/server/test/adversarial/*.test.ts` 自动化，要么在本文档记录手工验证结果。
> 状态：[ ] 未做 · [x] 通过 · [!] 发现问题（附 issue 编号，修复后改为 [x]）

## 验证结果（2026-10 最终回归）

| 套件 | 命令 | 结果 |
| --- | --- | --- |
| 单元+集成 | `npm test -w apps/server` | 98/98 通过 |
| 前端单元 | `npm test -w apps/web` | 2/2 通过 |
| 对抗性 A–E | `npm run test:adversarial` | 53/53 通过（233s） |
| 前端验收 F1–F4 | `npm run test:e2e -w apps/web` | 4/4 通过（Playwright，21s） |
| 类型检查 | `npm run typecheck` | 通过 |
| Lint | `npm run lint` | 通过 |
| 构建 | `npm run build` | 全部 workspace 通过 |
| 迁移可重复执行 | 已迁移库上重放 001–006 | 全部幂等 |

测试环境：Node v24、Docker postgres:16（`docker compose up -d`）、独立库 `gmp_adv` / `gmp_mig_check`。

## A. 进程级崩溃恢复（真实 kill -9，不是函数级模拟）

启动方式：测试用 `child_process.spawn` 起真实 server（tsx），随机端口，独立 DB；`kill -9` 后再次 spawn。
实现：`test/adversarial/a-restart.test.ts`（11 用例全过）。

- [x] R1 发送中崩溃：send 已 202 但进程在写 `accepted` 前被杀 → 重启后该消息最终 `sent`，网关恰好 1 条。
- [x] R2 建群 job 崩溃：分别在 create 后、invite 后、join 后、await_joins 中、promote 前杀死 → 重启后 job `finished`，网关只有 1 个群，promote 调用 ≤ 2。
- [x] R3 agent run 崩溃：在 send_message 的 executing 步已提交、网关已收到、tool_result 未写入时杀死 → 重启后 run 用同一 runId 继续，网关 1 条消息，steps 无重复行，最终 `finished`。
- [x] R4 agent 60s 时钟：run 进行到 elapsed≈5s 时杀死，停机 8s 再起 → 最终 run 的 elapsed_ms 不包含停机时间（通过 GET 观察 endReason 不是 wall_clock，且 DB elapsed_ms < 10s）。
- [x] R5 序列崩溃：3 步 [0.5s, 3s, 0.5s]，第 1 步发出后杀死，停机 5s（第 2 步已过期）→ 重启后第 2 步在 now+3s 发出（不是立即），第 3 步在第 2 步发出后 0.5s。
- [x] R6 事件流停机补齐：停机期间网关产生 20 个事件（含 duplicate + reorder）→ 重启后全部落库、无重复、agent 只被触发 1 次（agentEnabled 群）。
- [x] R7 unknown 对账崩溃：504 后 `unknown` 状态下杀死，重启 → 5s 内定论；不会双发。

## B. 混沌注入（同时开启 duplicateEvents + reorderEvents + SSE 每 2s 断线 + send 202 延迟 500–1500ms）

实现：`test/adversarial/b-chaos.test.ts`（8 用例全过，C0 负载 45s + drain）。

- [x] C1 `messages` 中 (group_id,msg_id) 唯一，且网关每条消息在 DB 都有且仅有一行。
- [x] C2 每个 client_msg_id 在网关 ≤ 1 条。
- [x] C3 所有 own 消息最终状态 ∈ {sent, failed, cancelled}（无残留 queued/accepted/unknown/sending，等待 10s 后检查）。
- [x] C4 `gateway_events` 行数 == 网关去重后事件数；`dead_events` 为空。
- [x] C5 网关成员列表 == DB group_members（每个 active 群）。
- [x] C6 agent_runs 中同一 group 从未出现两条时间重叠的 running（用 created_at/ended_at 区间检查）。
- [x] C7 ws_events seq 连续且 WS 客户端收到的 seq 严格递增无重复（含一次主动断线重连 sinceSeq）。

## C. 多实例

两个 server 进程共享同一 DB。实现：`test/adversarial/c-multi.test.ts`（4 用例全过）。

- [x] M1 S7：并发向两个实例各发一次序列启动 → 恰好 1 个 201、1 个 409。
- [x] M2 同群连续 3 条外部消息，两个实例都在消费事件流 → agent_runs 至多 1 个 running，pending 消息被合并进下一次 run。
- [x] M3 20 条 queued 消息 → 网关 sendCalls == 20（无重复领取），且每账号顺序 FIFO。
- [x] M4 两实例同时处理同一 job → job 状态机每步只执行一次（createGroup 只调 1 次）。

## D. 协议/规范一致性

实现：`test/adversarial/d-spec.test.ts`（16 用例全过）。

- [x] P1 枚举所有写路由（脚本从 fastify `printRoutes` 取），viewer 逐个调用 → 全部 403 `{error:{code:'FORBIDDEN',requestId}}`；无 token → 401 UNAUTHORIZED。
- [x] P2 所有 GET 响应的时间字段是 ISO 8601 UTC 字符串或 null（写一个递归校验器扫 accounts/groups/messages/agent-runs/sequence-runs/jobs）。
- [x] P3 `schema_migrations` 手动删掉最后一行 → 真实进程启动退出码 1；再 `npm run migrate` 两次 → 第二次 0 变更。
- [x] P4 `/agent/turn` 请求体：tools 恰好 4 个且 mock 校验通过（mock 返回 400 TOOLS_INVALID 的路径必须不会触发）；messages[0] 是 user text 触发上下文；tool_result 在 user 消息里；is_error 省略时视为 false。
- [x] P5 BAD_JSON 全部变体：500、非 JSON、```json 围栏、前后夹文字、content 2 块、content 0 块、stop_reason=end_turn 但块是 tool_use、stop_reason 缺失、stop_reason 未知值 → 每种都记 protocol_error 且 rawResponse 为原文（≤2KB）。
- [x] P6 tool_result content > 8KB 截断且 `truncated:true`；resultSummary ≤ 200 字（用 20KB 外部消息 + limit 50 验证）。
- [x] P7 `GET /api/groups/:id` 的 activeAgentRunId / activeSequenceRunId 在 running 时非空，结束后 null。

## E. 时序边界

实现：`test/adversarial/e-timing.test.ts`（E1–E7）+ `test/adversarial/e2-timing.test.ts`（E8–E13），14 用例全过。

- [x] E1 429 计时重置：账号限流 2s，期间操作员再 send 3 条 + 序列 1 步 + agent send 1 次 → 网关该账号 sendCalls 在窗口内不增加（否则计时会被重置，属严重错误）。
- [x] E2 限流到期前操作员标记 disconnected → 到期后不变回 online；队列消息保持 queued；再 connect 后按序发出。
- [x] E3 own 回流先于 message_sent 到达（reorder）→ 恰好 1 行，msgId 与 clientMsgId 都有，deliveryStatus=sent。
- [x] E4 补投事件 sentAt 早 1 小时 → 出现在时间线正确位置（分页第 N 页），不在头部；不会触发 agent（如果是 own）/ 会触发 agent（如果是外部消息，spec 未禁止）。
- [x] E5 504 + by-client-id 503 → 3s 内不重发；恢复 503 后 2s 内 accepted/sent/failed。
- [x] E6 504 消息在 1.99s 落地 → 不重发，最终 sent，网关 1 条。
- [x] E7 终态三来源等价：分别用 (a) send 返回 403 ACCOUNT_SUSPENDED (b) account_status 事件 (c) 操作员 transition，在完全相同的初始状态下触发 → 三次得到的 accounts/group_members/messages/sequence_run_steps/ws_events(type 序列) 快照一致。
- [x] E8 agent 审计恰好 3 次全部超时（每次 800ms）→ blocked，且 run 的 elapsed 包含审计等待；同一 run 内 blocked 后不再调 /agent/turn。
- [x] E9 agent 幂等：send k1 → AUDIT_REJECTED；send k1 → pass 发送；send k1 → 幂等回放（不审计）。审计调用总数 2。
- [x] E10 agent run 期间 PATCH agentEnabled=false → 当前步完成后 cancelled；期间到达的外部消息不会生成新 run，也不留 pending 垃圾（或 pending 被丢弃）。
- [x] E11 refresh 复用：login → refresh(R1→R2, A2) → 用 R1 再 refresh → 401，随后 A2 → 401，R2 → 401。
- [x] E12 logout 后原 access token 立即 401（含 WS auth 帧）。
- [x] E13 分页：120 条历史 + 翻页期间新增 5 条 own 消息并让其 sentAt 由受理时刻变为网关时刻 → 各页并集 == 120 条旧消息，无重复。

## F. 前端（Playwright 冒烟，C3）

实现：`apps/web/e2e/smoke.spec.ts` + `e2e/helpers.ts`（4 用例全过）。

- [x] F1 viewer 登录：账号页无按钮、群详情无发送框/开关/leave-all、agent run 页无取消、序列面板无启动。
- [x] F2 admin：登录 → 群 → 看到 agent run 列表 → 进入详情看到 steps，其中 protocol_error 步可展开 rawResponse。
- [x] F3 断线补齐：前端 WS 连接被服务端强制关闭，期间产生 5 个事件 → 3s 内页面出现且无重复。（实测重连后约 90–100ms 上屏）
- [x] F4 access token 过期（把有效期配成 5s）→ 页面操作自动续期一次，多个并发请求只触发一次 /refresh（拦截网络计数）。

## 对抗性测试发现并修复的缺陷

| 严重度 | 缺陷 | 修复 |
| --- | --- | --- |
| P1 | agent `elapsed_ms` 在 persistRun/persistAfterStep/endRun 三重累加，wall_clock 提前触发 | `engine.ts` 改为 `billDelta` 增量记账 |
| P1 | agent step 落库与 step_count 非原子，崩溃间隙导致恢复后 seq 唯一冲突、群 agent 永久停摆 | 全部改为事务化 `persistRunTx`/`endRunTx` |
| P1 | ws_events seq 分配先于 commit，commit 乱序时 pusher `seq>lastSeen` 永久漏发 | `ws/server.ts` 共享水位 + 回放窗口 + pending 缓冲 |
| P1 | GatewayClient 无超时，挂起 send → unknown → 重发 → 双发 | `AbortSignal.timeout`，网络/超时统一 `NETWORK_TIMEOUT` |
| P1 | sender `claimOne` 多实例 FIFO 竞态（M3 实证乱序） | 账号行 `FOR UPDATE SKIP LOCKED` + 单条领取 |
| P2 | `applyOutcome` 无 sending 守卫，迟到响应覆写已定论状态 | 更新前锁定并校验当前状态 |
| P2 | reconciler `sentAt::timestamptz` 强转毫秒数字抛错，unknown 行卡死 | 修正类型处理 |
| P2 | refresh 并发轮换竞态，同 token 双成功 | `UPDATE ... WHERE used_at IS NULL` 原子轮换，败者按复用处理作废 family |
| P2 | session revoked 缓存把 active 也缓存，跨实例 logout 延迟生效 | 仅缓存 revoked 标记，active 每次查 DB |
| P2 | 终态级联三来源不等价（E7 实证） | 统一级联：成员移除 + queued 取消 + 序列跳过 + member_changed 事件 + 网关 disconnect |
| P2 | `member_left` 与级联重复发 member_changed | consumer 删除行后按 rowCount 发事件 |
| P2 | unknown group 事件被静默丢弃 | 转入 dead_events |
| P2 | UUID 路径参数非法值触发 PG 22P02 而非 400 | `requireUuid` 校验 |
| P3 | 迁移 001–006 不可重复执行 | 全部加 `IF NOT EXISTS`/`ON CONFLICT` |
| P3 | pg.Pool 无 error 监听，PG 重启→进程崩溃 | pool.ts 挂 error handler |
| P3 | Bearer scheme 严格大小写（RFC 7235 应不敏感） | 大小写不敏感解析 |
| P3 | job 错误兜底映射 NETWORK_TIMEOUT 掩盖 DB 错误 | `gwCode` 仅网关错误用其 code，其余 `INTERNAL` |
| P3 | API 泄漏内部 `sending` 状态 | 时间线映射为 `queued` |
| 前端 | loadOlder 始终用第一页游标，无法翻第二页 | `olderCursor` 状态推进 |
| 前端 | `/api/auth/*` 401 被当会话过期触发 refresh | 排除 auth 路径 |
| 前端 | WS token 过期后无限重连不刷新 | 检测 auth 拒绝 → 共享 refresh → 重连 |
| 基建 | `spawn("npx")` 三层进程 kill 不干净致 DB 连接耗尽 | `node --import tsx` + detached 进程组 + `kill(-pid)` |

## 已知限制 / 未覆盖

- 性能/压测只有时序类用例（E 节），没有大流量 benchmark；spec 未给 QPS 指标。
- B 节混沌时长 45s（计划写 60s），断言等价。
- agent 时钟精度受 worker 轮询间隔影响，测试用阈值断言而非精确值。

## 第二轮：独立对抗性复核修复（regression.test.ts，9 用例）

对抗复核逐条对照源码验证，结论：9 项成立修复，2 项误报（SSE gap-jump 丢事件——`processEvent` 不按水位丢弃；不存在群 send 返回 200——`sendToGroup` 已 404）。

| 缺陷 | 修复 |
| --- | --- |
| `message_failed` 迟到事件无条件覆写 `sent`/`cancelled` 终态 | `onMessageFailed` 改为 `SELECT ... FOR UPDATE` + 终态守卫，覆写尝试转 `inconsistency(stale_failure)` 事件 |
| 未知群的 `member_joined`/`member_left` 静默丢弃（与 message 的 dead-letter 不一致） | 同 message：写 `dead_events` + `inconsistency(unknown_group)` |
| agent run 卡在 executing 步时取消永不落地（resolve bail → 循环跳过取消检查，run 永久 running） | stepRun 恢复分支补取消检查；无法确认的步记 `CANCELLED` 后结束 run |
| spec「从 run 创建起 60 秒，停机不计」字面语义下调度间隙漏计 | claim 时按 CASE 补计间隙：悬挂 lease（崩溃）=0；上次活动早于本进程启动=只计启动后；其余=全计 |
| `promoteCalls` 仅内存计数，崩溃后重放可超 spec 的 ≤2 次上限 | `persistJobState` 先落库再调用网关；已耗 2 次仍回到 promote 相位 → `RESULT_UNKNOWN` 错误、不再调用 |
| leave_all 逐成员 leave 进度只在循环末尾落库，崩溃中段重发 | 每个成员处理后 `persistJobState` 原位落库（不释放 lease，防并发重复步进） |
| `accepted` 无兜底：`message_sent` 永久丢失（如游标跳隙边缘）时消息永远停在中途 | reconciler 增加 stale-accepted 兜底：10s 未落地 → `by-client-id` 探到则补 `sent`；404 说明仍在网关队列，继续等（绝不重发已受理消息） |
| reconciler 把 unknown 解析为终态但不发 WS 事件，前端看不到状态翻转 | 两个 resolve 路径改为事务内 UPDATE + `emitWs('message')` |
| `creating` 泄漏出 `GET /api/groups` 响应枚举（spec 只有 active\|unreachable\|left） | 列表过滤 `status <> 'creating'`；详情对 creating 返回 404 |
| `inconsistency` 事件 WS 已推送但前端无消费，操作员不可见（A2「推事件通知操作员」形同虚设） | `alerts.ts` store + Layout 顶置警示条；`member_changed` 补 group 查询失效 |
| 外部成员 `accountId=null` 导致 React `key` 碰撞 | 成员行 key 改用 `platformUserId` |

mock-gateway 新增 `POST /__admin/emit-event` 测试口（注入任意 SSE 事件，用于制造真实流程造不出的乱序）。
