import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, ApiError } from "../api/client";
import type { Sequence } from "../api/types";

interface Props {
  groupId: string;
  onStarted: () => void;
}

interface ResolvedStep {
  index: number;
  resolvedVars: Record<string, string>;
  varSources: Record<string, string>;
  text: string;
}

export default function SequencePanel({ groupId, onStarted }: Props) {
  const navigate = useNavigate();
  const { data: sequences } = useQuery({
    queryKey: ["sequences"],
    queryFn: () => apiFetch("/api/sequences") as Promise<Sequence[]>,
  });
  const [seqId, setSeqId] = useState("");
  const selected = (sequences ?? []).find((s) => s.id === seqId);
  const [vars, setVars] = useState<{ k: string; v: string }[]>([]);
  const [stepVars, setStepVars] = useState<{ step: string; k: string; v: string }[]>([]);
  const [preview, setPreview] = useState<ResolvedStep[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newSteps, setNewSteps] = useState<
    { index: number; accountRole: "admin" | "member"; text: string; delaySeconds: number }[]
  >([{ index: 1, accountRole: "admin", text: "", delaySeconds: 0 }]);
  const [showCreate, setShowCreate] = useState(false);

  const varsObj = Object.fromEntries(vars.filter((r) => r.k).map((r) => [r.k, r.v]));
  const stepVarsObj: Record<string, Record<string, string>> = {};
  for (const r of stepVars) {
    if (!r.step || !r.k) continue;
    (stepVarsObj[r.step] ??= {})[r.k] = r.v;
  }

  const precheck = async () => {
    setErr(null);
    setPreview(null);
    try {
      const res = (await apiFetch(`/api/sequences/${seqId}/resolve`, {
        method: "POST",
        body: JSON.stringify({ vars: varsObj, stepVars: stepVarsObj }),
      })) as { steps: ResolvedStep[] };
      setPreview(res.steps);
    } catch (e) {
      if (e instanceof ApiError && e.code === "UNRESOLVED_PLACEHOLDER") {
        setErr(`第 ${String(e.extra?.stepIndex)} 步存在未提供变量 {${String(e.extra?.key)}}`);
      } else {
        setErr(e instanceof ApiError ? `${e.code}: ${e.message}` : "预检失败");
      }
    }
  };

  const start = async () => {
    setErr(null);
    try {
      const res = (await apiFetch(`/api/groups/${groupId}/sequence-runs`, {
        method: "POST",
        body: JSON.stringify({ sequenceId: seqId, vars: varsObj, stepVars: stepVarsObj }),
      })) as { runId: string };
      onStarted();
      navigate(`/sequence-runs/${res.runId}`);
    } catch (e) {
      setErr(e instanceof ApiError ? `${e.code}: ${e.message}` : "启动失败");
    }
  };

  const createSeq = async () => {
    setErr(null);
    try {
      const res = (await apiFetch("/api/sequences", {
        method: "POST",
        body: JSON.stringify({ name: newName, steps: newSteps }),
      })) as { id: string };
      setSeqId(res.id);
      setShowCreate(false);
      onStarted();
    } catch (e) {
      setErr(e instanceof ApiError ? `${e.code}: ${e.message}` : "创建失败");
    }
  };

  return (
    <div className="card">
      <h3>定时序列</h3>
      <p className="hint">
        序列是发信脚本：按步依次发送，每步可指定发送账号角色、文本（支持 {"{var}"}
        占位符）和延迟。延迟从上一条实际发出后起算。
      </p>
      <label>
        序列
        <select
          value={seqId}
          onChange={(e) => {
            const next = e.target.value;
            setSeqId(next);
            setPreview(null);
            const tpl = (sequences ?? []).find((s) => s.id === next);
            const keys = [
              ...new Set(
                (tpl?.steps ?? []).flatMap((s) =>
                  [...s.text.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]!),
                ),
              ),
            ];
            setVars((prev) => {
              const old = Object.fromEntries(prev.map((r) => [r.k, r.v]));
              return keys.map((k) => ({ k, v: old[k] ?? "" }));
            });
          }}
        >
          <option value="">选择序列</option>
          {(sequences ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}（{s.steps.length} 步）
            </option>
          ))}
        </select>
      </label>
      {selected && (
        <div className="seq-steps">
          {selected.steps.map((s) => (
            <div key={s.index} className="seq-step">
              <span className="seq-idx">#{s.index}</span>
              <span className="badge">{s.accountRole}</span>
              <span className="seq-text">{s.text}</span>
              <span className="seq-delay">+{s.delaySeconds}s</span>
            </div>
          ))}
        </div>
      )}
      <button className="link" onClick={() => setShowCreate(!showCreate)}>
        {showCreate ? "收起" : "新建序列"}
      </button>
      {showCreate && (
        <div className="card inner">
          <label>
            名称
            <input value={newName} onChange={(e) => setNewName(e.target.value)} />
          </label>
          <div className="step-row step-head">
            <span>步序</span>
            <span>发送角色</span>
            <span>文本（{"{var}"} 为占位符）</span>
            <span>延迟秒</span>
            <span></span>
          </div>
          {newSteps.map((s, i) => (
            <div key={i} className="step-row">
              <input
                type="number"
                className="idx"
                title="步序"
                value={s.index}
                onChange={(e) =>
                  setNewSteps(
                    newSteps.map((x, j) =>
                      j === i ? { ...x, index: Number(e.target.value) } : x,
                    ),
                  )
                }
              />
              <select
                value={s.accountRole}
                title="admin=群主/管理员账号发送；member=普通成员账号发送"
                onChange={(e) =>
                  setNewSteps(
                    newSteps.map((x, j) =>
                      j === i ? { ...x, accountRole: e.target.value as "admin" | "member" } : x,
                    ),
                  )
                }
              >
                <option value="admin">admin</option>
                <option value="member">member</option>
              </select>
              <input
                placeholder="文本 {var}"
                value={s.text}
                onChange={(e) =>
                  setNewSteps(newSteps.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))
                }
              />
              <input
                type="number"
                className="delay"
                title="延迟秒数：上一步实际发出后等待的秒数（第一步从启动起算）"
                value={s.delaySeconds}
                onChange={(e) =>
                  setNewSteps(
                    newSteps.map((x, j) =>
                      j === i ? { ...x, delaySeconds: Number(e.target.value) } : x,
                    ),
                  )
                }
              />
              <button onClick={() => setNewSteps(newSteps.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
          <button
            onClick={() =>
              setNewSteps([
                ...newSteps,
                { index: newSteps.length + 1, accountRole: "member", text: "", delaySeconds: 0 },
              ])
            }
          >
            + 步骤
          </button>
          <button disabled={!newName} onClick={() => void createSeq()}>
            保存序列
          </button>
        </div>
      )}
      <h4>
        变量 <small className="hint-inline">{"{var}"} 占位符在这里填值</small>
      </h4>
      {vars.map((r, i) => (
        <div key={i} className="step-row">
          <input
            placeholder="key"
            value={r.k}
            onChange={(e) => setVars(vars.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))}
          />
          <input
            placeholder="value"
            value={r.v}
            onChange={(e) => setVars(vars.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))}
          />
          <button onClick={() => setVars(vars.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      <button onClick={() => setVars([...vars, { k: "", v: "" }])}>+ 变量</button>
      <h4>
        按步覆盖 <small className="hint-inline">可选：到第 N 步时把某变量改成新值，向后延续</small>
      </h4>
      {stepVars.map((r, i) => (
        <div key={i} className="step-row">
          <input
            className="idx"
            placeholder="step"
            value={r.step}
            onChange={(e) =>
              setStepVars(stepVars.map((x, j) => (j === i ? { ...x, step: e.target.value } : x)))
            }
          />
          <input
            placeholder="key"
            value={r.k}
            onChange={(e) =>
              setStepVars(stepVars.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))
            }
          />
          <input
            placeholder="value"
            value={r.v}
            onChange={(e) =>
              setStepVars(stepVars.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))
            }
          />
          <button onClick={() => setStepVars(stepVars.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      <button onClick={() => setStepVars([...stepVars, { step: "", k: "", v: "" }])}>
        + stepVar
      </button>
      {err && <div className="error-banner">{err}</div>}
      {preview && (
        <div className="card inner preview">
          <h4>预检结果</h4>
          {preview.map((s) => (
            <div key={s.index} className="preview-step">
              <b>第 {s.index} 步：</b>
              {s.text}
              <div className="vars">
                {Object.entries(s.resolvedVars).map(([k, v]) => (
                  <span key={k}>
                    {k}=&quot;{v}&quot;（{s.varSources[k]}）
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="actions">
        <button disabled={!seqId} onClick={() => void precheck()}>
          预检
        </button>
        <button className="btn-primary" disabled={!preview} onClick={() => void start()}>
          启动
        </button>
      </div>
    </div>
  );
}
