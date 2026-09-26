export const ACCOUNT_STATUSES = [
  "idle",
  "online",
  "rate_limited",
  "disconnected",
  "suspended",
  "session_expired",
] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const TERMINAL_STATUSES: readonly AccountStatus[] = ["suspended", "session_expired"];

export const GROUP_STATUSES = ["creating", "active", "unreachable", "left"] as const;
export type GroupStatus = (typeof GROUP_STATUSES)[number];

export const DELIVERY_STATUSES = [
  "queued",
  "sending",
  "accepted",
  "sent",
  "failed",
  "unknown",
  "cancelled",
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const ErrorCodes = {
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  INTERNAL: "INTERNAL",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  ACCOUNT_NOT_FOUND: "ACCOUNT_NOT_FOUND",
  ILLEGAL_TRANSITION: "ILLEGAL_TRANSITION",
  CAS_CONFLICT: "CAS_CONFLICT",
  ACCOUNT_UNAVAILABLE: "ACCOUNT_UNAVAILABLE",
} as const;
export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export interface AccountView {
  id: string;
  status: AccountStatus;
  platformUserId: string | null;
  rateLimitedUntil: string | null;
}

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
  return TERMINAL_STATUSES.includes(status);
}
