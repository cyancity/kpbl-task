import { defineConfig } from "@playwright/test";

// 冒烟用例直接打外层会话已经在跑的 dev stack：
//   web :5173（vite 代理 /api、/ws 到 :3000）· server :3000 · mock-gateway :4000 · mock-agent :4100
// 所以这里不配 webServer。测试在 dev 库上造数，跑完数据留在 dev 环境。
export default defineConfig({
  testDir: "./e2e",
  // 用例会操纵 mock-agent 的全局剧本（"*" 前缀脚本）并共享同一组服务账号，必须串行。
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:5173",
    // 本机环境存在 :7890 代理变量/系统代理；localhost 流量必须直连。
    launchOptions: { args: ["--no-proxy-server"] },
    trace: "retain-on-failure",
  },
});
