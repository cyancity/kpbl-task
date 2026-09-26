import type { AccountStatus } from "@gmp/shared";

export const TRANSITIONS: Record<AccountStatus, AccountStatus[]> = {
  idle: ["online", "suspended", "session_expired"],
  online: ["idle", "rate_limited", "disconnected", "suspended", "session_expired"],
  rate_limited: ["online", "disconnected", "suspended", "session_expired"],
  disconnected: ["idle", "online", "suspended", "session_expired"],
  suspended: [],
  session_expired: [],
};

export function canTransition(from: AccountStatus, to: AccountStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(status: AccountStatus): boolean {
  return status === "suspended" || status === "session_expired";
}
