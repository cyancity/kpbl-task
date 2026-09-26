import { describe, it, expect } from "vitest";
import { ACCOUNT_STATUSES, type AccountStatus } from "@gmp/shared";
import { canTransition, isTerminal, TRANSITIONS } from "../src/domain/accounts/transitions.js";

// Expected matrix per spec A1 (row = from, col = to).
const EXPECTED: Record<AccountStatus, AccountStatus[]> = {
  idle: ["online", "suspended", "session_expired"],
  online: ["idle", "rate_limited", "disconnected", "suspended", "session_expired"],
  rate_limited: ["online", "disconnected", "suspended", "session_expired"],
  disconnected: ["idle", "online", "suspended", "session_expired"],
  suspended: [],
  session_expired: [],
};

describe("account transition table", () => {
  it("matches the spec matrix for all 36 pairs", () => {
    for (const from of ACCOUNT_STATUSES) {
      for (const to of ACCOUNT_STATUSES) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(EXPECTED[from].includes(to));
      }
    }
  });

  it("terminal statuses have no out-edges", () => {
    expect(TRANSITIONS.suspended).toEqual([]);
    expect(TRANSITIONS.session_expired).toEqual([]);
    expect(isTerminal("suspended")).toBe(true);
    expect(isTerminal("session_expired")).toBe(true);
    expect(isTerminal("online")).toBe(false);
  });

  it("same-state transitions are illegal", () => {
    for (const s of ACCOUNT_STATUSES) {
      expect(canTransition(s, s)).toBe(false);
    }
  });
});
