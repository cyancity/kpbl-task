import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, ApiError } from "../api/client";
import type { Account, AgentRun, Group, Job, MessageItem, SequenceRun } from "../api/types";
import { useCanWrite } from "../auth";
import SequencePanel from "../components/SequencePanel";

function Timeline({ groupId }: { groupId: string }) {
  const [pages, setPages] = useState<MessageItem[][]>([]);
  const [extra, setExtra] = useState<MessageItem[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const { data } = useQuery({
    queryKey: ["timeline", groupId],
    queryFn: async () => {
      const res = (await apiFetch(
        `/api/groups/${groupId}/messages?limit=50`,
      )) as { items: MessageItem[]; nextCursor: string | null };
      return res;
    },
    refetchInterval: 4000,
  });

  const items = useMemo(() => {
    const first = data?.items ?? [];
    const all = [...extra, ...pages.flat(), ...first];
    const seen = new Set<string>();
    return all
      .filter((m) => {
        const key = m.msgId ?? m.clientMsgId ?? m.sentAt;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => a.sentAt.localeCompare(b.sentAt));
  }, [data, pages, extra]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView();
  }, [items.length]);

  const loadOlder = async () => {
    if (!data?.nextCursor) return;
    const res = (await apiFetch(
      `/api/groups/${groupId}/messages?limit=50&before=${encodeURIComponent(data.nextCursor)}`,
    )) as { items: MessageItem[] };
    setPages((p) => [...p, res.items]);
    // older pages append at the front (they're older)
    setExtra((x) => x);
  };

  return (
    <div className="timeline card">
      {data?.nextCursor && (
        <button className="link" onClick={() => void loadOlder()}>
          加载更早
        </button>
      )}
      <div className="messages">
        {items.map((m, i) => (
          <div key={i} className={`msg ${m.isOwn ? "own" : ""}`}>
            <span className="sender">{m.senderPlatformUserId ?? "system"}</span>
            <span className="text">{m.text}</span>
            <span className="meta">
              {new Date(m.sentAt).toLocaleTimeString()}
              {m.isOwn && m.deliveryStatus && (
                <span className={`badge status-${m.deliveryStatus}`}> {m.deliveryStatus}</span>
              )}
              {m.failCode && <span className="error-text"> {m.failCode}</span>}
            </span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

export default function GroupDetail() {
  const { id } = useParams<{ id: string }>();
  const canWrite = useCanWrite();
  const [error, setError] = useState<string | null>(null);
  const [sendTo, setSendTo] = useState("");
  const [sendText, setSendText] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);

  const { data: group, refetch } = useQuery({
    queryKey: ["group", id],
    queryFn: () => apiFetch(`/api/groups/${id}`) as Promise<Group>,
  });
  const { data: accounts } = useQuery({
    queryKey: ["accounts"],
    queryFn: () => apiFetch("/api/accounts") as Promise<Account[]>,
  });
  const { data: agentRuns } = useQuery({
    queryKey: ["agent-runs", id],
    queryFn: () => apiFetch(`/api/groups/${id}/agent-runs`) as Promise<AgentRun[]>,
    refetchInterval: 5000,
  });
  const { data: seqRuns } = useQuery({
    queryKey: ["sequence-runs", id],
    queryFn: () => apiFetch(`/api/groups/${id}/sequence-runs`) as Promise<SequenceRun[]>,
    refetchInterval: 5000,
  });
  const { data: job } = useQuery({
    queryKey: ["job", jobId],
    enabled: !!jobId,
    refetchInterval: (q) =>
      q.state.data && (q.state.data as Job).status !== "running" ? false : 500,
    queryFn: () => apiFetch(`/api/jobs/${jobId}`) as Promise<Job>,
  });

  if (!group) return <p>加载中…</p>;

  const statusOf = (accountId: string) =>
    accounts?.find((a) => a.id === accountId)?.status ?? "unknown";
  const sendable = group.members.filter(
    (m) => statusOf(m.accountId) === "online" || statusOf(m.accountId) === "rate_limited",
  );

  const patch = async (field: "agentEnabled" | "autoKickEnabled", value: boolean) => {
    setError(null);
    try {
      await apiFetch(`/api/groups/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ [field]: value }),
      });
      void refetch();
    } catch (e) {
      setError(e instanceof ApiError ? `${e.code}: ${e.message}` : "操作失败");
    }
  };

  const leaveAll = async () => {
    setError(null);
    try {
      const res = (await apiFetch(`/api/groups/${id}/leave-all`, { method: "POST" })) as {
        jobId: string;
      };
      setJobId(res.jobId);
    } catch (e) {
      setError(e instanceof ApiError ? `${e.code}: ${e.message}` : "操作失败");
    }
  };

  const send = async () => {
    setError(null);
    try {
      await apiFetch(`/api/groups/${id}/send`, {
        method: "POST",
        body: JSON.stringify({ accountId: sendTo, text: sendText }),
      });
      setSendText("");
    } catch (e) {
      setError(e instanceof ApiError ? `${e.code}: ${e.message}` : "发送失败");
    }
  };

  return (
    <div>
      <p>
        <Link to="/groups">← 群组列表</Link>
      </p>
      <h1>
        群组 <code>{group.id.slice(0, 8)}</code>
      </h1>
      {error && <div className="error-banner">{error}</div>}
      <div className="card header-card">
        <span>
          状态：<span className={`badge status-${group.status}`}>{group.status}</span>
        </span>
        {canWrite && (
          <>
            <label className="inline">
              <input
                type="checkbox"
                checked={group.agentEnabled}
                onChange={(e) => void patch("agentEnabled", e.target.checked)}
              />
              agentEnabled
            </label>
            <label className="inline">
              <input
                type="checkbox"
                checked={group.autoKickEnabled}
                onChange={(e) => void patch("autoKickEnabled", e.target.checked)}
              />
              autoKickEnabled
            </label>
            <button onClick={() => void leaveAll()} disabled={group.status !== "active"}>
              全部退群
            </button>
          </>
        )}
        {job && (
          <span>
            leave-all job：{job.status}
            {job.errors.map((e, i) => (
              <span key={i} className="error-text">
                {" "}
                {e.step}:{e.code}
              </span>
            ))}
          </span>
        )}
      </div>
      <h3>成员</h3>
      <table>
        <thead>
          <tr>
            <th>账号</th>
            <th>平台用户</th>
            <th>角色</th>
          </tr>
        </thead>
        <tbody>
          {group.members.map((m) => (
            <tr key={m.accountId}>
              <td>{m.accountId}</td>
              <td>{m.platformUserId}</td>
              <td>{m.role}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>时间线</h3>
      <Timeline groupId={group.id} />
      {canWrite && (
        <div className="send-box">
          <select value={sendTo} onChange={(e) => setSendTo(e.target.value)}>
            <option value="">发送账号</option>
            {sendable.map((m) => (
              <option key={m.accountId} value={m.accountId}>
                {m.accountId}（{statusOf(m.accountId)}）
              </option>
            ))}
          </select>
          <input
            placeholder="消息内容"
            value={sendText}
            onChange={(e) => setSendText(e.target.value)}
          />
          <button disabled={!sendTo || !sendText} onClick={() => void send()}>
            发送
          </button>
        </div>
      )}
      <div className="two-col">
        <div>
          <h3>Agent 运行</h3>
          <table>
            <tbody>
              {(agentRuns ?? []).map((r) => (
                <tr key={r.id} className={r.status === "blocked" ? "row-error" : ""}>
                  <td>
                    <Link to={`/agent-runs/${r.id}`}>{r.id.slice(0, 8)}</Link>
                  </td>
                  <td>
                    <span className={`badge status-${r.status}`}>{r.status}</span>
                    {r.status === "blocked" && <span className="error-text"> 需要操作员处理</span>}
                  </td>
                  <td>{r.endReason ?? "—"}</td>
                  <td>{new Date(r.createdAt).toLocaleTimeString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3>序列运行</h3>
          <table>
            <tbody>
              {(seqRuns ?? []).map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link to={`/sequence-runs/${r.id}`}>{r.id.slice(0, 8)}</Link>
                  </td>
                  <td>
                    <span className={`badge status-${r.status}`}>{r.status}</span>
                  </td>
                  <td>step {r.currentStepIndex ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {canWrite && group.status === "active" && (
          <SequencePanel groupId={group.id} onStarted={() => void refetch()} />
        )}
      </div>
    </div>
  );
}
