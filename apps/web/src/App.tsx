import { useEffect } from "react";
import { Routes, Route, Link, NavLink, Navigate, Outlet, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "./auth";
import { connectWs } from "./ws";
import { getAccessToken, setAuthExpiredHandler } from "./api/client";
import { pushAlert, useAlerts, dismissAlert } from "./alerts";
import Login from "./pages/Login";
import Accounts from "./pages/Accounts";
import Groups from "./pages/Groups";
import GroupDetail from "./pages/GroupDetail";
import AgentRunDetail from "./pages/AgentRunDetail";
import SequenceRunDetail from "./pages/SequenceRunDetail";

function RequireAuth() {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  return <Outlet />;
}

function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const alerts = useAlerts();
  return (
    <>
      <header className="topbar">
        <Link to="/groups" className="brand">
          <span className="brand-mark" aria-hidden>
            <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
              <circle cx="3" cy="12" r="1.5" fill="currentColor" />
              <path
                d="M3 8a4 4 0 014 4"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
              <path
                d="M3 3.5A8.5 8.5 0 0111.5 12"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                opacity=".5"
              />
            </svg>
          </span>
          多账号群组消息平台
        </Link>
        <nav>
          <NavLink to="/accounts">账号</NavLink>
          <NavLink to="/groups">群组</NavLink>
        </nav>
        <span className="spacer" />
        <span className="user">
          {user?.username}（{user?.role}）
        </span>
        <button
          onClick={() => {
            void logout().then(() => navigate("/login"));
          }}
        >
          退出
        </button>
      </header>
      {alerts.length > 0 && (
        <div className="alerts" role="status">
          {alerts.map((a) => (
            <div key={a.id} className="alert">
              <span className="badge status-unknown">{a.kind}</span>
              <span className="alert-msg">{a.message}</span>
              <button className="alert-dismiss" onClick={() => dismissAlert(a.id)}>
                知道了
              </button>
            </div>
          ))}
        </div>
      )}
      <main>
        <Outlet />
      </main>
    </>
  );
}

export default function App() {
  const { user, clear } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();

  useEffect(() => {
    setAuthExpiredHandler(() => {
      clear();
      navigate("/login");
    });
  }, [clear, navigate]);

  useEffect(() => {
    if (!user) return;
    const handle = connectWs(getAccessToken, (ev) => {
      switch (ev.type) {
        case "account_status_changed":
          void qc.invalidateQueries({ queryKey: ["accounts"] });
          break;
        case "message":
          void qc.invalidateQueries({ queryKey: ["messages", ev.payload.groupId] });
          void qc.invalidateQueries({ queryKey: ["timeline", ev.payload.groupId] });
          break;
        case "group_status_changed":
          void qc.invalidateQueries({ queryKey: ["groups"] });
          void qc.invalidateQueries({ queryKey: ["group", ev.payload.groupId] });
          break;
        case "agent_run":
          void qc.invalidateQueries({ queryKey: ["agent-runs", ev.payload.groupId] });
          void qc.invalidateQueries({ queryKey: ["agent-run", ev.payload.runId] });
          break;
        case "sequence_run":
          void qc.invalidateQueries({ queryKey: ["sequence-runs", ev.payload.groupId] });
          void qc.invalidateQueries({ queryKey: ["sequence-run", ev.payload.runId] });
          break;
        case "job":
          void qc.invalidateQueries({ queryKey: ["job", ev.payload.jobId] });
          void qc.invalidateQueries({ queryKey: ["groups"] });
          break;
        case "member_changed":
          void qc.invalidateQueries({ queryKey: ["group", ev.payload.groupId] });
          break;
        case "inconsistency":
          pushAlert(
            String(ev.payload.kind ?? "inconsistency"),
            String(ev.payload.message ?? ""),
          );
          break;
      }
    });
    return () => handle.close();
  }, [user, qc]);

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<RequireAuth />}>
        <Route element={<Layout />}>
          <Route path="/" element={<Navigate to="/groups" replace />} />
          <Route path="/accounts" element={<Accounts />} />
          <Route path="/groups" element={<Groups />} />
          <Route path="/groups/:id" element={<GroupDetail />} />
          <Route path="/agent-runs/:id" element={<AgentRunDetail />} />
          <Route path="/sequence-runs/:id" element={<SequenceRunDetail />} />
        </Route>
      </Route>
    </Routes>
  );
}
