import Fastify, { FastifyInstance, FastifyReply } from "fastify";

// Deterministic PRNG so tests can pin behaviour via MOCK_SEED.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface MockConfig {
  sendDelayMinMs: number;
  sendDelayMaxMs: number;
  joinDelayMinMs: number;
  joinDelayMaxMs: number;
  kickDelayMinMs: number;
  kickDelayMaxMs: number;
  duplicateEvents: boolean;
  reorderEvents: boolean;
  unavailable: boolean;
  inviteReadyAfterMs: number;
  inviteExpireOnce: boolean;
  joinNeverArrives: string[];
  kickTimeout: boolean;
  leaveFail: string[];
  disconnectEverySeconds: number;
}

const defaultConfig = (): MockConfig => ({
  sendDelayMinMs: 50,
  sendDelayMaxMs: 2000,
  joinDelayMinMs: 100,
  joinDelayMaxMs: 1500,
  kickDelayMinMs: 1000,
  kickDelayMaxMs: 5000,
  duplicateEvents: false,
  reorderEvents: false,
  unavailable: false,
  inviteReadyAfterMs: 0,
  inviteExpireOnce: false,
  joinNeverArrives: [],
  kickTimeout: false,
  leaveFail: [],
  disconnectEverySeconds: 0,
});

interface InjectRule {
  code: string;
  retryAfterSeconds?: number;
  once?: boolean;
  actuallyDelivered?: boolean;
  /** Deterministic landing delay for a 504'd send that still lands. */
  landDelayMs?: number;
  httpStatus?: number;
}

interface AccountState {
  id: string;
  connected: boolean;
  platformUserId: string;
  terminal: "suspended" | "session_expired" | null;
  rateLimitedUntil: number;
  injected: InjectRule[];
  sendCalls: number;
}

interface Invite {
  link: string;
  readyAt: number;
  expireAt: number | null;
}

interface GroupState {
  id: string;
  creatorAccountId: string;
  members: Map<string, { accountId: string | null; role: "owner" | "admin" | "member" }>;
  invites: Invite[];
  inviteExpireUsed: boolean;
  writeForbidden: boolean;
  ownerLeft: boolean;
  promoteCalls: number;
  promoteInjected: InjectRule[];
}

interface StoredMessage {
  msgId: string;
  clientMsgId: string | null;
  sentAt: number;
}

interface EventRecord {
  eventId: number;
  type: string;
  data: Record<string, unknown>;
}

class MockGateway {
  config = defaultConfig();
  rand: () => number;
  accounts = new Map<string, AccountState>();
  groups = new Map<string, GroupState>();
  events: EventRecord[] = [];
  seq = 0;
  groupSeq = 0;
  msgSeq = 0;
  inviteSeq = 0;
  messagesByGroup = new Map<string, StoredMessage[]>();
  joinAttempts: Array<{ groupId: string; accountId: string; at: number }> = [];
  sseClients = new Set<{ reply: FastifyReply; lastSent: number }>();
  media = new Map<string, Buffer>();

  constructor(seed: number) {
    this.rand = mulberry32(seed);
  }

  reset(): void {
    this.accounts.clear();
    this.groups.clear();
    this.events = [];
    this.seq = 0;
    this.groupSeq = 0;
    this.msgSeq = 0;
    this.inviteSeq = 0;
    this.messagesByGroup.clear();
    this.media.clear();
    this.joinAttempts = [];
  }

  delay(min: number, max: number): number {
    if (max <= min) return min;
    return Math.floor(min + this.rand() * (max - min));
  }

  account(id: string): AccountState {
    let a = this.accounts.get(id);
    if (!a) {
      a = {
        id,
        connected: false,
        platformUserId: `pu-${id}`,
        terminal: null,
        rateLimitedUntil: 0,
        injected: [],
        sendCalls: 0,
      };
      this.accounts.set(id, a);
    }
    return a;
  }

  emit(type: string, data: Record<string, unknown>): void {
    const eventId = ++this.seq;
    const record: EventRecord = {
      eventId,
      type,
      data: { ...data, eventId, type },
    };
    this.events.push(record);
    const dispatch = () => this.deliver(record);
    if (this.config.reorderEvents) {
      // Hold each event a random sub-second delay so neighbours can arrive out of order.
      setTimeout(dispatch, this.delay(0, 1000)).unref();
    } else {
      dispatch();
    }
    if (this.config.duplicateEvents) {
      if (this.config.reorderEvents) {
        setTimeout(dispatch, this.delay(0, 1000)).unref();
      } else {
        dispatch();
      }
    }
  }

  private deliver(record: EventRecord): void {
    const frame =
      `id: ${record.eventId}\n` +
      `event: ${record.type}\n` +
      `data: ${JSON.stringify(record.data)}\n\n`;
    // Always write: delivery is at-least-once and may be out of order; the
    // consumer is responsible for deduplication.
    for (const client of this.sseClients) {
      client.reply.raw.write(frame);
      client.lastSent = Math.max(client.lastSent, record.eventId);
    }
  }

  setTerminal(accountId: string, status: "suspended" | "session_expired"): void {
    const a = this.account(accountId);
    a.terminal = status;
    a.connected = false;
    this.emit("account_status", { accountId, status });
    for (const group of this.groups.values()) {
      if (group.members.delete(a.platformUserId)) {
        this.emit("member_left", { groupId: group.id, platformUserId: a.platformUserId });
      }
    }
  }

  groupMessages(groupId: string): StoredMessage[] {
    let list = this.messagesByGroup.get(groupId);
    if (!list) {
      list = [];
      this.messagesByGroup.set(groupId, list);
    }
    return list;
  }

  landMessage(
    group: GroupState,
    account: AccountState,
    clientMsgId: string,
    text: string,
    mediaUrl?: string,
  ): void {
    if (group.writeForbidden) {
      this.emit("message_failed", {
        groupId: group.id,
        clientMsgId,
        code: "GROUP_WRITE_FORBIDDEN",
      });
      return;
    }
    if (account.terminal) {
      this.emit("message_failed", {
        groupId: group.id,
        clientMsgId,
        code: "ACCOUNT_SUSPENDED",
      });
      return;
    }
    const msgId = `m-${++this.msgSeq}`;
    const sentAt = Date.now();
    this.groupMessages(group.id).push({ msgId, clientMsgId, sentAt });
    this.emit("message_sent", { groupId: group.id, clientMsgId, msgId, sentAt });
    this.emit("message", {
      groupId: group.id,
      msgId,
      senderPlatformUserId: account.platformUserId,
      text,
      sentAt,
      ...(mediaUrl ? { mediaUrl } : {}),
    });
  }
}

function err(reply: FastifyReply, status: number, code: string, extra: object = {}): FastifyReply {
  return reply.code(status).send({ error: { code, ...extra } });
}

export function buildMockGateway(opts: { seed?: number } = {}): FastifyInstance {
  const gw = new MockGateway(opts.seed ?? Number(process.env.MOCK_SEED ?? 1));
  const app = Fastify({ logger: false });

  const unavailable = (reply: FastifyReply): boolean => {
    if (gw.config.unavailable) {
      err(reply, 503, "UNAVAILABLE");
      return true;
    }
    return false;
  };

  // ---------- accounts ----------
  app.post("/accounts/:accountId/connect", (req, reply) => {
    if (unavailable(reply)) return;
    const { accountId } = req.params as { accountId: string };
    const a = gw.account(accountId);
    if (a.terminal === "suspended") return err(reply, 403, "ACCOUNT_SUSPENDED");
    if (a.terminal === "session_expired") return err(reply, 401, "SESSION_EXPIRED");
    a.connected = true;
    return { platformUserId: a.platformUserId };
  });

  app.post("/accounts/:accountId/disconnect", (req, reply) => {
    if (unavailable(reply)) return;
    const { accountId } = req.params as { accountId: string };
    const a = gw.account(accountId);
    if (a.terminal === "suspended") return err(reply, 403, "ACCOUNT_SUSPENDED");
    if (a.terminal === "session_expired") return err(reply, 401, "SESSION_EXPIRED");
    a.connected = false;
    return {};
  });

  // ---------- groups ----------
  app.post("/groups", (req, reply) => {
    if (unavailable(reply)) return;
    const { creatorAccountId } = (req.body ?? {}) as { creatorAccountId?: string };
    if (!creatorAccountId) return err(reply, 400, "BAD_REQUEST");
    const a = gw.account(creatorAccountId);
    if (a.terminal === "suspended") return err(reply, 403, "ACCOUNT_SUSPENDED");
    if (a.terminal === "session_expired") return err(reply, 401, "SESSION_EXPIRED");
    if (!a.connected) return err(reply, 409, "ACCOUNT_OFFLINE");
    const id = `g-${++gw.groupSeq}`;
    const members = new Map<
      string,
      { accountId: string | null; role: "owner" | "admin" | "member" }
    >();
    members.set(a.platformUserId, { accountId: creatorAccountId, role: "owner" });
    gw.groups.set(id, {
      id,
      creatorAccountId,
      members,
      invites: [],
      inviteExpireUsed: false,
      writeForbidden: false,
      ownerLeft: false,
      promoteCalls: 0,
      promoteInjected: [],
    });
    return { groupId: id };
  });

  app.post("/groups/:groupId/invite", (req, reply) => {
    if (unavailable(reply)) return;
    const { groupId } = req.params as { groupId: string };
    const group = gw.groups.get(groupId);
    if (!group) return err(reply, 404, "GROUP_NOT_FOUND");
    const readyAfterMs = gw.config.inviteReadyAfterMs;
    const invite: Invite = {
      link: `inv-${++gw.inviteSeq}`,
      readyAt: Date.now() + readyAfterMs,
      expireAt: null,
    };
    if (gw.config.inviteExpireOnce && !group.inviteExpireUsed) {
      invite.expireAt = Date.now() - 1;
      group.inviteExpireUsed = true;
    }
    group.invites.push(invite);
    return { inviteLink: invite.link, readyAfterMs };
  });

  app.post("/groups/:groupId/join", (req, reply) => {
    if (unavailable(reply)) return;
    const { groupId } = req.params as { groupId: string };
    const { accountId, inviteLink } = (req.body ?? {}) as {
      accountId?: string;
      inviteLink?: string;
    };
    const group = gw.groups.get(groupId);
    if (!group) return err(reply, 404, "GROUP_NOT_FOUND");
    if (!accountId || !inviteLink) return err(reply, 400, "BAD_REQUEST");
    const a = gw.account(accountId);
    if (a.terminal === "suspended") return err(reply, 403, "ACCOUNT_SUSPENDED");
    if (a.terminal === "session_expired") return err(reply, 401, "SESSION_EXPIRED");
    gw.joinAttempts.push({ groupId, accountId, at: Date.now() });
    if (!a.connected) return err(reply, 409, "ACCOUNT_OFFLINE");
    if (group.members.has(a.platformUserId)) return err(reply, 409, "ALREADY_MEMBER");
    const invite = group.invites.find((i) => i.link === inviteLink);
    if (!invite || (invite.expireAt !== null && Date.now() >= invite.expireAt)) {
      return err(reply, 410, "INVITE_EXPIRED");
    }
    if (Date.now() < invite.readyAt) return err(reply, 409, "INVITE_NOT_READY");
    if (!gw.config.joinNeverArrives.includes(accountId)) {
      const wait = gw.delay(gw.config.joinDelayMinMs, gw.config.joinDelayMaxMs);
      setTimeout(() => {
        if (!group.members.has(a.platformUserId)) {
          group.members.set(a.platformUserId, { accountId, role: "member" });
          gw.emit("member_joined", { groupId, platformUserId: a.platformUserId });
        }
      }, wait).unref();
    }
    return reply.code(202).send({ accepted: true });
  });

  app.post("/groups/:groupId/promote", (req, reply) => {
    if (unavailable(reply)) return;
    const { groupId } = req.params as { groupId: string };
    const { byAccountId, accountId } = (req.body ?? {}) as {
      byAccountId?: string;
      accountId?: string;
    };
    const group = gw.groups.get(groupId);
    if (!group) return err(reply, 404, "GROUP_NOT_FOUND");
    if (!byAccountId || !accountId) return err(reply, 400, "BAD_REQUEST");
    const by = gw.account(byAccountId);
    const target = gw.account(accountId);
    group.promoteCalls += 1;
    const injected = group.promoteInjected.shift();
    if (injected) {
      if (injected.once === false) group.promoteInjected.unshift(injected);
      return err(reply, 409, injected.code);
    }
    const byMember = group.members.get(by.platformUserId);
    if (!byMember || byMember.role !== "owner") return err(reply, 403, "NO_PERMISSION");
    const targetMember = group.members.get(target.platformUserId);
    if (!targetMember) return err(reply, 409, "NOT_MEMBER_YET");
    targetMember.role = "admin";
    return {};
  });

  app.post("/groups/:groupId/kick", async (req, reply) => {
    if (unavailable(reply)) return;
    const { groupId } = req.params as { groupId: string };
    const { byAccountId, targetPlatformUserId } = (req.body ?? {}) as {
      byAccountId?: string;
      targetPlatformUserId?: string;
    };
    const group = gw.groups.get(groupId);
    if (!group) return err(reply, 404, "GROUP_NOT_FOUND");
    if (group.ownerLeft) return err(reply, 409, "OWNER_LEFT");
    if (!byAccountId || !targetPlatformUserId) return err(reply, 400, "BAD_REQUEST");
    const by = gw.account(byAccountId);
    const byMember = group.members.get(by.platformUserId);
    if (!byMember || (byMember.role !== "owner" && byMember.role !== "admin")) {
      return err(reply, 403, "NO_PERMISSION");
    }
    const doKick = () => {
      if (group.members.delete(targetPlatformUserId)) {
        gw.emit("member_left", { groupId, platformUserId: targetPlatformUserId });
      }
    };
    if (gw.config.kickTimeout) {
      // Result unknown to the caller, but the kick still lands within 2s.
      setTimeout(doKick, gw.delay(100, 1900)).unref();
      await new Promise((r) => setTimeout(r, 3000));
      return err(reply, 504, "NETWORK_TIMEOUT");
    }
    const wait = gw.delay(gw.config.kickDelayMinMs, gw.config.kickDelayMaxMs);
    await new Promise((r) => setTimeout(r, wait));
    doKick();
    return { kicked: true };
  });

  app.post("/groups/:groupId/leave", (req, reply) => {
    if (unavailable(reply)) return;
    const { groupId } = req.params as { groupId: string };
    const { accountId } = (req.body ?? {}) as { accountId?: string };
    const group = gw.groups.get(groupId);
    if (!group) return err(reply, 404, "GROUP_NOT_FOUND");
    if (!accountId) return err(reply, 400, "BAD_REQUEST");
    const a = gw.account(accountId);
    if (a.terminal === "suspended") return err(reply, 403, "ACCOUNT_SUSPENDED");
    if (a.terminal === "session_expired") return err(reply, 401, "SESSION_EXPIRED");
    if (!a.connected) return err(reply, 409, "ACCOUNT_OFFLINE");
    if (gw.config.leaveFail.includes(accountId)) {
      return err(reply, 500, "LEAVE_FAILED");
    }
    const member = group.members.get(a.platformUserId);
    if (member?.role === "owner") group.ownerLeft = true;
    if (group.members.delete(a.platformUserId)) {
      gw.emit("member_left", { groupId, platformUserId: a.platformUserId });
    }
    return {};
  });

  app.get("/groups/:groupId/members", (req, reply) => {
    if (unavailable(reply)) return;
    const { groupId } = req.params as { groupId: string };
    const group = gw.groups.get(groupId);
    if (!group) return err(reply, 404, "GROUP_NOT_FOUND");
    return [...group.members.keys()].map((platformUserId) => ({ platformUserId }));
  });

  // ---------- send ----------
  app.post("/groups/:groupId/send", (req, reply) => {
    if (unavailable(reply)) return;
    const { groupId } = req.params as { groupId: string };
    const { accountId, clientMsgId, text, mediaUrl } = (req.body ?? {}) as {
      accountId?: string;
      clientMsgId?: string;
      text?: string;
      mediaUrl?: string;
    };
    const group = gw.groups.get(groupId);
    if (!group) return err(reply, 404, "GROUP_NOT_FOUND");
    if (!accountId || !clientMsgId) return err(reply, 400, "BAD_REQUEST");
    const a = gw.account(accountId);
    a.sendCalls += 1;
    if (a.terminal === "suspended") return err(reply, 403, "ACCOUNT_SUSPENDED");
    if (a.terminal === "session_expired") return err(reply, 401, "SESSION_EXPIRED");
    if (!a.connected) return err(reply, 409, "ACCOUNT_OFFLINE");

    const injected = a.injected.shift();
    if (injected) {
      if (injected.once === false) {
        // non-once rules persist until explicitly cleared
        a.injected.unshift(injected);
      }
      if (injected.code === "RATE_LIMITED") {
        const retryAfterSeconds = injected.retryAfterSeconds ?? 5;
        a.rateLimitedUntil = Date.now() + retryAfterSeconds * 1000;
        return err(reply, 429, "RATE_LIMITED", { retryAfterSeconds });
      }
      if (injected.code === "NETWORK_TIMEOUT") {
        if (injected.actuallyDelivered) {
          setTimeout(
            () => gw.landMessage(group, a, clientMsgId, text ?? "", mediaUrl),
            injected.landDelayMs ?? gw.delay(100, 1900),
          ).unref();
        }
        return err(reply, 504, "NETWORK_TIMEOUT");
      }
      if (injected.code === "SUSPENDED" || injected.code === "ACCOUNT_SUSPENDED") {
        gw.setTerminal(accountId, "suspended");
        return err(reply, 403, "ACCOUNT_SUSPENDED");
      }
      if (injected.code === "SESSION_EXPIRED") {
        gw.setTerminal(accountId, "session_expired");
        return err(reply, 401, "SESSION_EXPIRED");
      }
      return err(reply, injected.httpStatus ?? 500, injected.code);
    }

    if (Date.now() < a.rateLimitedUntil) {
      const retryAfterSeconds = Math.ceil((a.rateLimitedUntil - Date.now()) / 1000);
      a.rateLimitedUntil = Date.now() + retryAfterSeconds * 1000; // timer resets on each send
      return err(reply, 429, "RATE_LIMITED", { retryAfterSeconds });
    }
    if (group.writeForbidden) return err(reply, 403, "GROUP_WRITE_FORBIDDEN");
    if (!group.members.has(a.platformUserId)) return err(reply, 403, "SENDER_NOT_IN_GROUP");

    const wait = gw.delay(gw.config.sendDelayMinMs, gw.config.sendDelayMaxMs);
    setTimeout(() => gw.landMessage(group, a, clientMsgId, text ?? "", mediaUrl), wait).unref();
    return reply.code(202).send({ accepted: true });
  });

  app.get("/groups/:groupId/messages/by-client-id/:clientMsgId", (req, reply) => {
    if (unavailable(reply)) return;
    const { groupId, clientMsgId } = req.params as { groupId: string; clientMsgId: string };
    const list = gw.groupMessages(groupId).filter((m) => m.clientMsgId === clientMsgId);
    if (!list.length) return err(reply, 404, "NOT_FOUND");
    list.sort((a, b) => a.sentAt - b.sentAt);
    return { msgId: list[0]!.msgId, sentAt: list[0]!.sentAt };
  });

  app.get("/media/:id", (req, reply) => {
    const { id } = req.params as { id: string };
    const buf = gw.media.get(id);
    if (!buf) return err(reply, 404, "NOT_FOUND");
    return reply.send(buf);
  });

  // ---------- events (SSE) ----------
  app.get("/events", (req, reply) => {
    const since = Number((req.query as { since?: string }).since ?? 0);
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const client = { reply, lastSent: since };
    for (const ev of gw.events) {
      if (ev.eventId > since) {
        reply.raw.write(
          `id: ${ev.eventId}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n`,
        );
        client.lastSent = ev.eventId;
      }
    }
    gw.sseClients.add(client);
    req.raw.on("close", () => gw.sseClients.delete(client));

    if (gw.config.disconnectEverySeconds > 0) {
      setTimeout(() => reply.raw.end(), gw.config.disconnectEverySeconds * 1000).unref();
    }
  });

  // ---------- admin ----------
  app.post("/__admin/reset", () => {
    gw.reset();
    gw.config = defaultConfig();
    return { ok: true };
  });

  app.post("/__admin/config", (req) => {
    const patch = (req.body ?? {}) as Partial<MockConfig>;
    Object.assign(gw.config, patch);
    return { ok: true, config: gw.config };
  });

  app.post("/__admin/accounts/:id/inject", (req, reply) => {
    const { id } = req.params as { id: string };
    const rule = (req.body ?? {}) as InjectRule & { httpStatus?: number };
    if (!rule.code) return err(reply, 400, "BAD_REQUEST");
    gw.account(id).injected.push(rule);
    return { ok: true };
  });

  app.post("/__admin/accounts/:id/status", (req, reply) => {
    const { id } = req.params as { id: string };
    const { status } = (req.body ?? {}) as { status?: string };
    if (status !== "suspended" && status !== "session_expired") {
      return err(reply, 400, "BAD_REQUEST");
    }
    gw.setTerminal(id, status);
    return { ok: true };
  });

  app.post("/__admin/groups/:id/inject", (req, reply) => {
    const { id } = req.params as { id: string };
    const { code, once } = (req.body ?? {}) as { code?: string; once?: boolean };
    const group = gw.groups.get(id);
    if (!group) return err(reply, 404, "GROUP_NOT_FOUND");
    if (code === "GROUP_WRITE_FORBIDDEN") group.writeForbidden = true;
    else if (code === "NOT_MEMBER_YET")
      group.promoteInjected.push(once === undefined ? { code } : { code, once });
    return { ok: true };
  });

  app.post("/__admin/groups/:id/external-message", (req, reply) => {
    const { id } = req.params as { id: string };
    const { platformUserId, text, mediaUrl } = (req.body ?? {}) as {
      platformUserId?: string;
      text?: string;
      mediaUrl?: string;
    };
    const group = gw.groups.get(id);
    if (!group || !platformUserId) return err(reply, 404, "GROUP_NOT_FOUND");
    const msgId = `m-${++gw.msgSeq}`;
    gw.emit("message", {
      groupId: id,
      msgId,
      senderPlatformUserId: platformUserId,
      text: text ?? "",
      sentAt: Date.now(),
      ...(mediaUrl ? { mediaUrl } : {}),
    });
    return { ok: true, msgId };
  });

  app.post("/__admin/groups/:id/external-join", (req, reply) => {
    const { id } = req.params as { id: string };
    const { platformUserId } = (req.body ?? {}) as { platformUserId?: string };
    const group = gw.groups.get(id);
    if (!group || !platformUserId) return err(reply, 404, "GROUP_NOT_FOUND");
    if (!group.members.has(platformUserId)) {
      group.members.set(platformUserId, { accountId: null, role: "member" });
      gw.emit("member_joined", { groupId: id, platformUserId });
    }
    return { ok: true };
  });

  app.post("/__admin/groups/:id/external-leave", (req, reply) => {
    const { id } = req.params as { id: string };
    const { platformUserId } = (req.body ?? {}) as { platformUserId?: string };
    const group = gw.groups.get(id);
    if (!group || !platformUserId) return err(reply, 404, "GROUP_NOT_FOUND");
    if (group.members.delete(platformUserId)) {
      gw.emit("member_left", { groupId: id, platformUserId });
    }
    return { ok: true };
  });

  app.get("/__admin/state", () => ({
    config: gw.config,
    accounts: [...gw.accounts.values()].map((a) => ({
      ...a,
      injected: a.injected,
    })),
    groups: [...gw.groups.values()].map((g) => ({
      id: g.id,
      creatorAccountId: g.creatorAccountId,
      members: [...g.members.entries()].map(([platformUserId, m]) => ({
        platformUserId,
        ...m,
      })),
      writeForbidden: g.writeForbidden,
      ownerLeft: g.ownerLeft,
      promoteCalls: g.promoteCalls,
    })),
    joinAttempts: gw.joinAttempts,
    events: gw.events,
    messages: [...gw.messagesByGroup.entries()].map(([groupId, msgs]) => ({
      groupId,
      messages: msgs,
    })),
  }));

  return app;
}

if (process.env.MOCK_GATEWAY_RUN !== "0" && import.meta.url === `file://${process.argv[1]}`) {
  const app = buildMockGateway();
  const port = Number(process.env.GATEWAY_PORT ?? 4000);
  app.listen({ port, host: "0.0.0.0" }).then(() => {
    console.log(`mock-gateway listening on ${port}`);
  });
}
