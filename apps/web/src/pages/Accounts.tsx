import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { canTransition, type AccountStatus } from "@gmp/shared";
import { apiFetch, ApiError } from "../api/client";
import type { Account } from "../api/types";
import { useCanWrite } from "../auth";

const STATUS_LABEL: Record<AccountStatus, string> = {
  idle: "空闲",
  online: "在线",
  rate_limited: "限流",
  disconnected: "离线",
  suspended: "已封禁",
  session_expired: "会话过期",
};

export default function Accounts() {
  const canWrite = useCanWrite();
  const [error, setError] = useState<string | null>(null);
  const { data: accounts, refetch } = useQuery({
    queryKey: ["accounts"],
    queryFn: () => apiFetch("/api/accounts") as Promise<Account[]>,
    refetchInterval: 5000,
  });

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      void refetch();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : "操作失败");
    }
  };

  return (
    <div>
      <h1>账号</h1>
      {error && <div className="error-banner">{error}</div>}
      <table>
        <thead>
          <tr>
            <th>账号</th>
            <th>状态</th>
            <th>平台用户 ID</th>
            <th>限流至</th>
            {canWrite && <th>操作</th>}
          </tr>
        </thead>
        <tbody>
          {(accounts ?? []).map((a) => {
            const canOffline = canTransition(a.status, "disconnected");
            const canIdle = canTransition(a.status, "idle");
            const canConnect = a.status === "idle" || a.status === "disconnected";
            return (
              <tr key={a.id}>
                <td>{a.id}</td>
                <td>
                  <span className={`badge status-${a.status}`}>{STATUS_LABEL[a.status]}</span>
                </td>
                <td>{a.platformUserId ?? "—"}</td>
                <td>{a.rateLimitedUntil ? new Date(a.rateLimitedUntil).toLocaleTimeString() : "—"}</td>
                {canWrite && (
                  <td className="actions">
                    {canConnect && (
                      <button
                        onClick={() =>
                          void act(() =>
                            apiFetch(`/api/accounts/${a.id}/connect`, { method: "POST" }),
                          )
                        }
                      >
                        重连
                      </button>
                    )}
                    {canOffline && (
                      <button
                        onClick={() =>
                          void act(() =>
                            apiFetch(`/api/accounts/${a.id}/transition`, {
                              method: "POST",
                              body: JSON.stringify({
                                to: "disconnected",
                                expectedFrom: a.status,
                              }),
                            }),
                          )
                        }
                      >
                        标记离线
                      </button>
                    )}
                    {canIdle && (
                      <button
                        onClick={() =>
                          void act(() =>
                            apiFetch(`/api/accounts/${a.id}/transition`, {
                              method: "POST",
                              body: JSON.stringify({ to: "idle", expectedFrom: a.status }),
                            }),
                          )
                        }
                      >
                        释放账号
                      </button>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
