import { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { AppContext } from "../context.js";
import { runLoop, type WorkerHandle } from "../workers/loop.js";

interface AuthedSocket {
  socket: WebSocket;
  lastSeq: number;
}

const sockets = new Set<AuthedSocket>();

export function registerWsRoute(app: FastifyInstance, ctx: AppContext): void {
  app.get("/ws", { websocket: true }, (socket: WebSocket) => {
    let authed = false;
    const entry: AuthedSocket = { socket, lastSeq: 0 };

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
      socket.send(JSON.stringify({ type: "auth", success: true }));

      if (typeof msg.sinceSeq === "number") {
        const { rows } = await ctx.pool.query<{
          seq: string;
          type: string;
          payload: unknown;
        }>("SELECT seq, type, payload FROM ws_events WHERE seq > $1 ORDER BY seq", [msg.sinceSeq]);
        for (const r of rows) {
          const seq = Number(r.seq);
          socket.send(JSON.stringify({ seq, type: r.type, payload: r.payload }));
          entry.lastSeq = Math.max(entry.lastSeq, seq);
        }
      } else {
        const { rows } = await ctx.pool.query<{ max: string | null }>(
          "SELECT max(seq) AS max FROM ws_events",
        );
        entry.lastSeq = Number(rows[0]?.max ?? 0);
      }
      sockets.add(entry);
    });

    socket.on("close", () => sockets.delete(entry));
    socket.on("error", () => sockets.delete(entry));
  });
}

export function startWsPusher(ctx: AppContext, intervalMs = 200): WorkerHandle {
  let lastSeen = 0;
  return runLoop(
    "ws-pusher",
    intervalMs,
    async () => {
      const { rows } = await ctx.pool.query<{
        seq: string;
        type: string;
        payload: unknown;
      }>("SELECT seq, type, payload FROM ws_events WHERE seq > $1 ORDER BY seq LIMIT 500", [
        lastSeen,
      ]);
      for (const r of rows) {
        const seq = Number(r.seq);
        lastSeen = Math.max(lastSeen, seq);
        for (const s of sockets) {
          if (seq > s.lastSeq && s.socket.readyState === s.socket.OPEN) {
            s.socket.send(JSON.stringify({ seq, type: r.type, payload: r.payload }));
            s.lastSeq = seq;
          }
        }
      }
    },
    ctx.log,
  );
}
