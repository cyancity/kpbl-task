import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth";
import { ApiError } from "../api/client";

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username, password);
      navigate("/groups");
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : "登录失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-brand">
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
      </div>
      <form className="card login-card" onSubmit={submit}>
        <h1>登录</h1>
        <label>
          用户名
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
        </label>
        <label>
          密码
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && <div className="error-banner">{error}</div>}
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? "登录中…" : "登录"}
        </button>
      </form>
    </div>
  );
}
