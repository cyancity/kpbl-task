import { createContext, useContext, useState, type ReactNode } from "react";
import { apiFetch, setAccessToken } from "./api/client";

export interface User {
  username: string;
  role: string;
}

interface AuthCtx {
  user: User | null;
  isAdmin: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  clear: () => void;
}

const Ctx = createContext<AuthCtx>({
  user: null,
  isAdmin: false,
  login: async () => {},
  logout: async () => {},
  clear: () => {},
});

const USER_KEY = "gmp_user";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(() => {
    const raw = sessionStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as User) : null;
  });

  const login = async (username: string, password: string) => {
    const res = (await apiFetch("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    })) as { accessToken: string };
    setAccessToken(res.accessToken);
    const me = (await apiFetch("/api/auth/me")) as User;
    setUser(me);
    sessionStorage.setItem(USER_KEY, JSON.stringify(me));
  };

  const logout = async () => {
    try {
      await apiFetch("/api/auth/logout", { method: "POST" });
    } catch {
      // best effort
    }
    setAccessToken(null);
    setUser(null);
    sessionStorage.removeItem(USER_KEY);
  };

  const clear = () => {
    setUser(null);
    sessionStorage.removeItem(USER_KEY);
  };

  return (
    <Ctx.Provider value={{ user, isAdmin: user?.role === "admin", login, logout, clear }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAuth() {
  return useContext(Ctx);
}

export function useCanWrite() {
  return useContext(Ctx).isAdmin;
}
