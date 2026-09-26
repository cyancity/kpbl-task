import { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { AppContext } from "../context.js";
import { runLoop, type WorkerHandle } from "../workers/loop.js";

interface PendingEvent {
  seq: number;
  type: string;
  payload: unknown;
}

interface AuthedSocket {
  socket: WebSocket;
  lastSeq: number;
  // While replaying the sinceSeq backlog the pusher buffers instead of
  // sending, so the client always sees strictly increasing seq values.
  replaying: boolean;
  pending: PendingEvent[];
}

const sockets = new Set<AuthedSocket>();
const AUTH_TIMEOUT_MS = 10_000;

// Highest seq the pusher has safely delivered past — everything at or below it
// is committed and was broadcast (a seq hole blocks the watermark until the
// transaction commits or the grace window expires). Replays only read up to
// this mark so a late-committing row can never be stranded below a client's
// lastSeq.
const highWater = { value: 0 };

export function registerWsRoute(app: FastifyInstance, ctx: AppContext): void {
  app.get("/ws", { websocket: true }, (socket: WebSocket) => {
    let authed = false;
    const entry: AuthedSocket = { socket, lastSeq: 0, replaying: false, pending: [] };
    const authTimer = setTimeout(() => {
      if (!authed) socket.close();
    }, AUTH_TIMEOUT_MS);
    authTimer.unref();

    socket.on("message", async (raw: Buffer) => {
      if (authed) return;
      let msg: { type?: string; accessToken?: string; sinceSeq?: number };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        socket.send(JSON.stringify({ type: "auth", success: false, code: "UNAUTHORIZED" }));
        socket.close();
        return;
      }
      if (msg.type !== "auth" || !msg.accessToken) {
        socket.send(JSON.stringify({ type: "auth", success: false, code: "UNAUTHORIZED" }));
        socket.close();
        return;
      }
      try {
        await ctx.verifyAccess(msg.accessToken);
      } catch {
        socket.send(JSON.stringify({ type: "auth", success: false, code: "UNAUTHORIZED" }));
        socket.close();
        return;
      }
      authed = true;
      clearTimeout(authTimer);

      try {
        const { rows: maxRow } = await ctx.pool.query<{ max: string | null }>(
          "SELECT max(seq) AS max FROM ws_events",
        );
        const committedMax = Number(maxRow[0]?.max ?? 0);
        // maxSeq lets the client detect a server-side reset: if its stored
        // lastSeq is beyond the table's max, replays would silently cover
        // nothing and future low seqs would look like duplicates.
        socket.send(JSON.stringify({ type: "auth", success: true, maxSeq: committedMax }));

        const cap = highWater.value;
        const sinceSeq =
          typeof msg.sinceSeq === "number" ? Math.min(msg.sinceSeq, committedMax) : cap;
        // Register before replaying: events committed between the snapshot read
        // and registration would otherwise be lost. They arrive via the pusher
        // while replaying is true and are flushed in order afterwards.
        entry.lastSeq = sinceSeq;
        entry.replaying = true;
        sockets.add(entry);
        try {
          if (sinceSeq < cap) {
            const { rows } = await ctx.pool.query<{
              seq: string;
              type: string;
              payload: unknown;
            }>(
              "SELECT seq, type, payload FROM ws_events WHERE seq > $1 AND seq <= $2 ORDER BY seq",
              [sinceSeq, cap],
            );
            for (const r of rows) {
              const seq = Number(r.seq);
              if (seq <= entry.lastSeq) continue; // pusher beat us to it
              socket.send(JSON.stringify({ seq, type: r.type, payload: r.payload }));
              entry.lastSeq = seq;
            }
          }
          // Absorb the watermark: rows in (replayMax, cap] either came through
          // the pending buffer or are holes the pusher already adjudicated.
          entry.lastSeq = Math.max(entry.lastSeq, cap, sinceSeq);
        } finally {
          entry.replaying = false;
          const pending = entry.pending.sort((a, b) => a.seq - b.seq);
          entry.pending = [];
          for (const p of pending) {
            if (p.seq <= entry.lastSeq) continue;
            if (socket.readyState === socket.OPEN) {
              socket.send(JSON.stringify({ seq: p.seq, type: p.type, payload: p.payload }));
            }
            entry.lastSeq = Math.max(entry.lastSeq, p.seq);
          }
        }
      } catch (err) {
        ctx.log.warn({ err }, "ws auth/replay failed");
        socket.close();
      }
    });

    socket.on("close", () => {
      clearTimeout(authTimer);
      sockets.delete(entry);
    });
    socket.on("error", () => sockets.delete(entry));
  });
}

// ws_events.seq is assigned at INSERT time, so commit order can lag seq order
// by a beat. If we see a gap, wait a few ticks for the in-flight transaction
// to commit instead of permanently skipping its row; only step over a hole
// that has not filled (aborted transaction) after the grace window.
const GAP_GRACE_MS = 1500;

export function startWsPusher(ctx: AppContext, intervalMs = 200): WorkerHandle {
  let gapSince: number | null = null;
  let initialized = false;
  return runLoop(
    "ws-pusher",
    intervalMs,
    async () => {
      if (!initialized) {
        // Start at the current max: rows written before this process booted
        // are replayed to clients via sinceSeq, not re-broadcast to everyone.
        const { rows: m } = await ctx.pool.query<{ max: string | null }>(
          "SELECT max(seq) AS max FROM ws_events",
        );
        highWater.value = Number(m[0]?.max ?? 0);
        initialized = true;
      }
      const { rows } = await ctx.pool.query<{
        seq: string;
        type: string;
        payload: unknown;
      }>("SELECT seq, type, payload FROM ws_events WHERE seq > $1 ORDER BY seq LIMIT 500", [
        highWater.value,
      ]);
      for (const r of rows) {
        const seq = Number(r.seq);
        if (seq > highWater.value + 1) {
          if (gapSince === null) gapSince = Date.now();
          if (Date.now() - gapSince < GAP_GRACE_MS) break; // retry next tick
          // The hole never filled: its transaction aborted. Step over it.
        }
        gapSince = null;
        highWater.value = seq;
        for (const s of sockets) {
          if (seq > s.lastSeq) {
            if (s.replaying) {
              s.pending.push({ seq, type: r.type, payload: r.payload });
            } else if (s.socket.readyState === s.socket.OPEN) {
              s.socket.send(JSON.stringify({ seq, type: r.type, payload: r.payload }));
              s.lastSeq = seq;
            }
          }
        }
      }
    },
    ctx.log,
  );
}
