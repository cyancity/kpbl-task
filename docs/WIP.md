# WIP 交接文档

## 目标

全栈笔试题：多账号群消息平台（账号生命周期 / 建群 job / 可靠外发与对账 / agent 工具执行 / 定时序列 / WS 实时事件 / 认证会话 / React 控制台），要求可审查的工程质量和全量验证。

原始题面见 `PLAN.md` 引用的考试文档；验证清单见 `TEST_PLAN.md`。

## 当前状态：实现与验证全部完成

分支 `fix/adversarial-hardening`，基于 main（p1–p6 全部落地）+ 对抗性审查修复。

最终验证（本机，Node v24 + Docker postgres:16）：

- `npm test -w apps/server`：98/98
- `npm test -w apps/web`：2/2
- `npm run test:adversarial`：53/53（A 崩溃恢复 11、B 混沌 8、C 多实例 4、D 规范 16、E 时序 14）
- `npm run test:e2e -w apps/web`：F1–F4 Playwright 4/4
- `npm run typecheck` / `lint` / `build`：全过
- 迁移 001–006 在已迁移库上重放幂等

本轮对抗性测试发现并修复的缺陷清单见 `TEST_PLAN.md` 末节（5 个 P1、若干 P2/P3、3 个前端 bug、测试基建进程泄漏）。

## 环境

- Postgres：`docker compose up -d`（容器 `kpbl-task-postgres-1`，端口 5432）
- 库：`gmp_dev`（开发）、`gmp_adv`（对抗性）、`gmp_test` 等按 `test/helpers.ts` 约定
- dev：`npm run dev` 一键起 gateway:4000 / agent:4100 / server:3000 / web:5173
- 种子账号：`admin/admin`、`viewer/viewer`；`acc-1`…`acc-6`
- macOS 注意：若 `localhost` 解析到 IPv6 而服务只听 IPv4，API 地址用 `127.0.0.1`；shell 里残留的无协议头 `http_proxy` 会让 npm/fetch 报 `ERR_INVALID_URL`，用 `env -u http_proxy -u https_proxy -u all_proxy` 跑测试。

## 下一步

- 等验收后合并 main（当前未合并）
- 可选项：B 节混沌时长从 45s 拉到 60s；补大流量性能用例（spec 未要求指标）
