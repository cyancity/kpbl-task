# WIP 交接文档

## 目标

全栈笔试题：多账号群消息平台（账号生命周期 / 建群 job / 可靠外发与对账 / agent 工具执行 / 定时序列 / WS 实时事件 / 认证会话 / React 控制台），要求可审查的工程质量和全量验证。

原始题面见 `PLAN.md` 引用的考试文档；验证清单见 `TEST_PLAN.md`。

## 当前状态：第二轮评审修复完成，全量验证通过

分支 `fix/adversarial-hardening`，基于 main（p1–p6 全部落地）+ 两轮审查修复：

1. 第一轮对抗性测试（原 22 项缺陷，见 TEST_PLAN.md 末节）
2. 第二轮面试官视角独立评审 → 逐条复核 → 9 项成立修复 + 2 项误报澄清（见 TEST_PLAN.md 新增小节与 `test/regression.test.ts` 9 用例）

最终验证（本机，Node v24 + Docker postgres:16）：

- `npm test -w apps/server`：107/107（8 文件，含 regression.test.ts 9 用例）
- `npm test -w apps/web`：2/2
- `npm run test:adversarial`：53/53（A 崩溃恢复 11、B 混沌 8、C 多实例 4、D 规范 16、E 时序 14）
- `npm run test:e2e -w apps/web`：F1–F4 Playwright 4/4
- `npm run typecheck` / `lint` / `build`：全过
- 迁移 001–006 在已迁移库上重放幂等

第二轮修复摘要：`message_failed` 覆写终态守卫、未知群 member 事件 dead-letter、executing 步可取消、agent 时钟补计调度间隙（停机仍不计）、promoteCalls 先落库再调用（≤2 硬上限）、leave_all 逐成员 checkpoint、accepted 悬挂由 reconciler 经 by-client-id 兜底、解析定论时发 WS 事件、`creating` 不再泄漏出公开枚举、前端 inconsistency 警示条 + member_changed 失效 + React key 修复；mock-gateway 新增 `__admin/emit-event` 注入口。

## 环境

- Postgres：`docker compose up -d`（容器 `kpbl-task-postgres-1`，端口 5432）
- 库：`gmp_dev`（开发）、`gmp_adv`（对抗性）、`gmp_test` 等按 `test/helpers.ts` 约定
- dev：`npm run dev` 一键起 gateway:4000 / agent:4100 / server:3000 / web:5173
- 种子账号：`admin/admin`、`viewer/viewer`；`acc-1`…`acc-6`
- macOS 注意：若 `localhost` 解析到 IPv6 而服务只听 IPv4，API 地址用 `127.0.0.1`；shell 里残留的无协议头 `http_proxy` 会让 npm/fetch 报 `ERR_INVALID_URL`，用 `env -u http_proxy -u https_proxy -u all_proxy` 跑测试。
- dev 栈陷阱：mock-gateway/mock-agent 是内存进程。旧 dev/test 进程被 kill 后端口可能仍被占，新 `npm run dev` 起不来或半新半旧——表现为建群 `ACCOUNT_OFFLINE`/`JOIN_TIMEOUT`/网关 fault 残留。跑 e2e 前 `lsof -nP -iTCP:3000,4000,4100,5173 -sTCP:LISTEN` 确认四个进程都是本轮 PID。另：网关重启后群 ID 从 `g-1` 重新计数，`gmp_dev` 里的旧 `gateway_group_id` 会让新建群撞唯一键（报 `INTERNAL`），需清 `groups` 等域表（保留 accounts/users/schema_migrations）。

## 下一步

- 等验收后合并 main（当前未合并）
- 可选项：B 节混沌时长从 45s 拉到 60s；补大流量性能用例（spec 未要求指标）
