import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, ApiError } from "../api/client";
import type { AgentRun } from "../api/types";
import { useCanWrite } from "../auth";

export default function AgentRunDetail() {
  const { id } = useParams<{ id: string }>();
  const canWrite = useCanWrite();
  const [error, setError] = useState<string | null>(null);
  const [rawOpen, setRawOpen] = useState<number | null>(null);

  const { data: run, refetch } = useQuery({
    queryKey: ["agent-run", id],
    queryFn: () => apiFetch(`/api/agent-runs/${id}`) as Promise<AgentRun>,
    refetchInterval: (q) => {
      const d = q.state.data as AgentRun | undefined;
      return d && (d.status === "running") ? 1000 : false;
    },
  });

  if (!run) return <p>加载中…</p>;
  return (
    <div>
      <p>
        <Link to={`/groups/${run.groupId}`}>← 返回群组</Link>
      </p>
      <h1>
        Agent Run <code>{run.id.slice(0, 8)}</code>
      </h1>
      <div className={`card ${run.status === "blocked" ? "blocked" : ""}`}>
        <p>
          状态：<span className={`badge status-${run.status}`}>{run.status}</span>
          {run.endReason && <span> · {run.endReason}</span>}
        </p>
        {run.status === "blocked" && <p className="error-text">需要操作员处理</p>}
        {run.summary && <p>summary: {run.summary}</p>}
        {canWrite && run.status === "running" && (
          <button
            onClick={() =>
              void apiFetch(`/api/agent-runs/${run.id}/cancel`, { method: "POST" })
                .then(() => refetch())
                .catch((e) => setError(e instanceof ApiError ? e.message : "取消失败"))
            }
          >
            取消
          </button>
        )}
        {error && <div className="error-banner">{error}</div>}
      </div>
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>kind</th>
            <th>name</th>
            <th>input</th>
            <th>result</th>
            <th>audit</th>
            <th>error</th>
          </tr>
        </thead>
        <tbody>
          {(run.steps ?? []).map((s) => (
            <tr key={s.seq} className={s.isError ? "row-error" : ""}>
              <td>{s.seq}</td>
              <td>{s.kind}</td>
              <td>{s.name ?? "—"}</td>
              <td>
                <code className="pre">{s.input ? JSON.stringify(s.input) : "—"}</code>
              </td>
              <td>{s.resultSummary ?? "—"}</td>
              <td>{s.auditVerdict ?? "—"}</td>
              <td>
                {s.isError ? (s.errorCode ?? "error") : "—"}
                {s.rawResponse && (
                  <button className="link" onClick={() => setRawOpen(rawOpen === s.seq ? null : s.seq)}>
                    {rawOpen === s.seq ? "收起" : "查看原始响应"}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rawOpen !== null && (
        <div className="card">
          <h4>rawResponse（step {rawOpen}）</h4>
          <pre className="raw">
            {run.steps?.find((s) => s.seq === rawOpen)?.rawResponse ?? ""}
          </pre>
        </div>
      )}
    </div>
  );
}
