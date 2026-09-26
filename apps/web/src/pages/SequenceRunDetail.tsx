import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../api/client";
import type { SequenceRun } from "../api/types";

export default function SequenceRunDetail() {
  const { id } = useParams<{ id: string }>();
  const { data: run } = useQuery({
    queryKey: ["sequence-run", id],
    queryFn: () => apiFetch(`/api/sequence-runs/${id}`) as Promise<SequenceRun>,
    refetchInterval: (q) => {
      const d = q.state.data as SequenceRun | undefined;
      return d && d.status === "running" ? 1000 : false;
    },
  });

  if (!run) return <p>加载中…</p>;
  return (
    <div>
      <p>
        <Link to={`/groups/${run.groupId}`}>← 返回群组</Link>
      </p>
      <h1>
        序列运行 <code>{run.id.slice(0, 8)}</code>
      </h1>
      <p>
        状态：<span className={`badge status-${run.status}`}>{run.status}</span> · 当前步：{" "}
        {run.currentStepIndex ?? "—"}
      </p>
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>状态</th>
            <th>计划时间</th>
            <th>发出时间</th>
            <th>账号</th>
            <th>变量</th>
          </tr>
        </thead>
        <tbody>
          {run.steps.map((s) => (
            <tr key={s.index}>
              <td>{s.index}</td>
              <td>
                <span className={`badge status-${s.status}`}>{s.status}</span>
              </td>
              <td>{s.scheduledAt ? new Date(s.scheduledAt).toLocaleTimeString() : "—"}</td>
              <td>{s.sentAt ? new Date(s.sentAt).toLocaleTimeString() : "—"}</td>
              <td>{s.accountId ?? "—"}</td>
              <td>
                {Object.entries(s.resolvedVars).map(([k, v]) => (
                  <div key={k}>
                    <code>{k}</code>={v} <small>({s.varSources[k]})</small>
                  </div>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
