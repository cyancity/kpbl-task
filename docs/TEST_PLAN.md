# 对抗性验证用例清单

> 目的：以"故意找茬"的方式验证 PLAN.md 中列出的陷阱 T1–T38 是否真的被覆盖。
> 每条用例要么由 `apps/server/test/adversarial/*.test.ts` 自动化，要么在本文档记录手工验证结果。
> 状态：[ ] 未做 · [x] 通过 · [!] 发现问题（附 issue 编号，修复后改为 [x]）

## A. 进程级崩溃恢复（真实 kill -9，不是函数级模拟）

启动方式：测试用 `child_process.spawn` 起真实 server（tsx），随机端口，独立 DB；`kill -9` 后再次 spawn。

- [ ] R1 发送中崩溃：send 已 202 但进程在写 `accepted` 前被杀 → 重启后该消息最终 `sent`，网关恰好 1 条。
- [ ] R2 建群 job 崩溃：分别在 create 后、invite 后、join 后、await_joins 中、promote 前杀死 → 重启后 job `finished`，网关只有 1 个群，promote 调用 ≤ 2。
- [ ] R3 agent run 崩溃：在 send_message 的 executing 步已提交、网关已收到、tool_result 未写入时杀死 → 重启后 run 用同一 runId 继续，网关 1 条消息，steps 无重复行，最终 `finished`。
- [ ] R4 agent 60s 时钟：run 进行到 elapsed≈5s 时杀死，停机 8s 再起 → 最终 run 的 elapsed_ms 不包含停机时间（通过 GET 观察 endReason 不是 wall_clock，且 DB elapsed_ms < 10s）。
- [ ] R5 序列崩溃：3 步 [0.5s, 3s, 0.5s]，第 1 步发出后杀死，停机 5s（第 2 步已过期）→ 重启后第 2 步在 now+3s 发出（不是立即），第 3 步在第 2 步发出后 0.5s。
- [ ] R6 事件流停机补齐：停机期间网关产生 20 个事件（含 duplicate + reorder）→ 重启后全部落库、无重复、agent 只被触发 1 次（agentEnabled 群）。
- [ ] R7 unknown 对账崩溃：504 后 `unknown` 状态下杀死，重启 → 5s 内定论；不会双发。

## B. 混沌注入（同时开启 duplicateEvents + reorderEvents + SSE 每 2s 断线 + send 202 延迟 500–1500ms）

跑 60s 混合负载：操作员 send ×20、序列 1 个（5 步）、agent 触发 5 次、外部用户消息 ×30。结束后断言不变量：
- [ ] C1 `messages` 中 (group_id,msg_id) 唯一，且网关每条消息在 DB 都有且仅有一行。
- [ ] C2 每个 client_msg_id 在网关 ≤ 1 条。
- [ ] C3 所有 own 消息最终状态 ∈ {sent, failed, cancelled}（无残留 queued/accepted/unknown/sending，等待 10s 后检查）。
- [ ] C4 `gateway_events` 行数 == 网关去重后事件数；`dead_events` 为空。
- [ ] C5 网关成员列表 == DB group_members（每个 active 群）。
- [ ] C6 agent_runs 中同一 group 从未出现两条时间重叠的 running（用 created_at/ended_at 区间检查）。
- [ ] C7 ws_events seq 连续且 WS 客户端收到的 seq 严格递增无重复（含一次主动断线重连 sinceSeq）。

## C. 多实例

两个 server 进程共享同一 DB：
- [ ] M1 S7：并发向两个实例各发一次序列启动 → 恰好 1 个 201、1 个 409。
- [ ] M2 同群连续 3 条外部消息，两个实例都在消费事件流 → agent_runs 至多 1 个 running，pending 消息被合并进下一次 run。
- [ ] M3 20 条 queued 消息 → 网关 sendCalls == 20（无重复领取），且每账号顺序 FIFO。
- [ ] M4 两实例同时处理同一 job → job 状态机每步只执行一次（createGroup 只调 1 次）。

## D. 协议/规范一致性

- [ ] P1 枚举所有写路由（脚本从 fastify `printRoutes` 取），viewer 逐个调用 → 全部 403 `{error:{code:'FORBIDDEN',requestId}}`；无 token → 401 UNAUTHORIZED。
- [ ] P2 所有 GET 响应的时间字段是 ISO 8601 UTC 字符串或 null（写一个递归校验器扫 accounts/groups/messages/agent-runs/sequence-runs/jobs）。
- [ ] P3 `schema_migrations` 手动删掉最后一行 → 真实进程启动退出码 1；再 `npm run migrate` 两次 → 第二次 0 变更。
- [ ] P4 `/agent/turn` 请求体：tools 恰好 4 个且 mock 校验通过（mock 返回 400 TOOLS_INVALID 的路径必须不会触发）；messages[0] 是 user text 触发上下文；tool_result 在 user 消息里；is_error 省略时视为 false。
- [ ] P5 BAD_JSON 全部变体：500、非 JSON、```json 围栏、前后夹文字、content 2 块、content 0 块、stop_reason=end_turn 但块是 tool_use、stop_reason 缺失、stop_reason 未知值 → 每种都记 protocol_error 且 rawResponse 为原文（≤2KB）。
- [ ] P6 tool_result content > 8KB 截断且 `truncated:true`；resultSummary ≤ 200 字（用 20KB 外部消息 + limit 50 验证）。
- [ ] P7 `GET /api/groups/:id` 的 activeAgentRunId / activeSequenceRunId 在 running 时非空，结束后 null。

## E. 时序边界

- [ ] E1 429 计时重置：账号限流 2s，期间操作员再 send 3 条 + 序列 1 步 + agent send 1 次 → 网关该账号 sendCalls 在窗口内不增加（否则计时会被重置，属严重错误）。
- [ ] E2 限流到期前操作员标记 disconnected → 到期后不变回 online；队列消息保持 queued；再 connect 后按序发出。
- [ ] E3 own 回流先于 message_sent 到达（reorder）→ 恰好 1 行，msgId 与 clientMsgId 都有，deliveryStatus=sent。
- [ ] E4 补投事件 sentAt 早 1 小时 → 出现在时间线正确位置（分页第 N 页），不在头部；不会触发 agent（如果是 own）/ 会触发 agent（如果是外部消息，spec 未禁止）。
- [ ] E5 504 + by-client-id 503 → 3s 内不重发；恢复 503 后 2s 内 accepted/sent/failed。
- [ ] E6 504 消息在 1.99s 落地 → 不重发，最终 sent，网关 1 条。
- [ ] E7 终态三来源等价：分别用 (a) send 返回 403 ACCOUNT_SUSPENDED (b) account_status 事件 (c) 操作员 transition，在完全相同的初始状态下触发 → 三次得到的 accounts/group_members/messages/sequence_run_steps/ws_events(type 序列) 快照一致。
- [ ] E8 agent 审计恰好 3 次全部超时（每次 800ms）→ blocked，且 run 的 elapsed 包含审计等待；同一 run 内 blocked 后不再调 /agent/turn。
- [ ] E9 agent 幂等：send k1 → AUDIT_REJECTED；send k1 → pass 发送；send k1 → 幂等回放（不审计）。审计调用总数 2。
- [ ] E10 agent run 期间 PATCH agentEnabled=false → 当前步完成后 cancelled；期间到达的外部消息不会生成新 run，也不留 pending 垃圾（或 pending 被丢弃）。
- [ ] E11 refresh 复用：login → refresh(R1→R2, A2) → 用 R1 再 refresh → 401，随后 A2 → 401，R2 → 401。
- [ ] E12 logout 后原 access token 立即 401（含 WS auth 帧）。
- [ ] E13 分页：120 条历史 + 翻页期间新增 5 条 own 消息并让其 sentAt 由受理时刻变为网关时刻 → 各页并集 == 120 条旧消息，无重复。

## F. 前端（Playwright 冒烟，C3）

- [ ] F1 viewer 登录：账号页无按钮、群详情无发送框/开关/leave-all、agent run 页无取消、序列面板无启动。
- [ ] F2 admin：登录 → 群 → 看到 agent run 列表 → 进入详情看到 steps，其中 protocol_error 步可展开 rawResponse。
- [ ] F3 断线补齐：前端 WS 连接被服务端强制关闭，期间产生 5 个事件 → 3s 内页面出现且无重复。
- [ ] F4 access token 过期（把有效期配成 5s）→ 页面操作自动续期一次，多个并发请求只触发一次 /refresh（拦截网络计数）。
