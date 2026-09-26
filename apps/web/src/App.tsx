import { useEffect } from "react";
import { Routes, Route, Link, Navigate, Outlet, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "./auth";
import { connectWs } from "./ws";
import { getAccessToken, setAuthExpiredHandler } from "./api/client";
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
  return (
    <>
      <header className="topbar">
        <span className="brand">多账号群组消息平台</span>
        <nav>
          <Link to="/accounts">账号</Link>
          <Link to="/groups">群组</Link>
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
