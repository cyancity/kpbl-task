import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, ApiError } from "../api/client";
import type { Account, Group, Job } from "../api/types";
import { useCanWrite } from "../auth";

function CreateGroupForm({ onDone }: { onDone: () => void }) {
  const { data: accounts } = useQuery({
    queryKey: ["accounts"],
    queryFn: () => apiFetch("/api/accounts") as Promise<Account[]>,
  });
  const online = (accounts ?? []).filter((a) => a.status === "online");
  const [creator, setCreator] = useState("");
  const [members, setMembers] = useState<string[]>([]);
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: job } = useQuery({
    queryKey: ["job", jobId],
    enabled: !!jobId,
    refetchInterval: (q) =>
      q.state.data && (q.state.data as Job).status !== "running" ? false : 500,
    queryFn: () => apiFetch(`/api/jobs/${jobId}`) as Promise<Job>,
  });

  const submit = async () => {
    setError(null);
    try {
      const res = (await apiFetch("/api/groups", {
        method: "POST",
        body: JSON.stringify({
          creatorAccountId: creator,
          memberAccountIds: members.filter((m) => m !== creator),
        }),
      })) as { jobId: string };
      setJobId(res.jobId);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : "创建失败");
    }
  };

  return (
    <div className="card">
      <h3>建群</h3>
      <label>
        群主账号
        <select value={creator} onChange={(e) => setCreator(e.target.value)}>
          <option value="">选择账号</option>
          {online.map((a) => (
            <option key={a.id} value={a.id}>
              {a.id}
            </option>
          ))}
        </select>
      </label>
      <fieldset>
        <legend>成员</legend>
        {online.map((a) => (
          <label key={a.id} className="inline">
            <input
              type="checkbox"
              checked={members.includes(a.id)}
              onChange={(e) =>
                setMembers(
                  e.target.checked ? [...members, a.id] : members.filter((m) => m !== a.id),
                )
              }
            />
            {a.id}
          </label>
        ))}
      </fieldset>
      {error && <div className="error-banner">{error}</div>}
      <button disabled={!creator} onClick={() => void submit()}>
        创建
      </button>
      {job && (
        <div className="job-status">
          job {job.id.slice(0, 8)}：{job.status}
          {job.errors.length > 0 && (
            <ul>
              {job.errors.map((e, i) => (
                <li key={i} className="error-text">
                  {e.step}: {e.code}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export default function Groups() {
  const canWrite = useCanWrite();
  const { data: groups, refetch } = useQuery({
    queryKey: ["groups"],
    queryFn: () => apiFetch("/api/groups") as Promise<Group[]>,
  });

  return (
    <div>
      <h1>群组</h1>
      <div className="two-col">
        <table>
          <thead>
            <tr>
              <th>群组</th>
              <th>状态</th>
              <th>群主</th>
              <th>成员数</th>
            </tr>
          </thead>
          <tbody>
            {(groups ?? []).map((g) => (
              <tr key={g.id}>
                <td>
                  <Link to={`/groups/${g.id}`}>{g.id.slice(0, 8)}…</Link>
                </td>
                <td>
                  <span className={`badge status-${g.status}`}>{g.status}</span>
                </td>
                <td>{g.creatorAccountId}</td>
                <td>{g.members.length}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {canWrite && <CreateGroupForm onDone={() => void refetch()} />}
      </div>
    </div>
  );
}
