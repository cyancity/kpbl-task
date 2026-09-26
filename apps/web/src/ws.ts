import { refreshToken } from "./api/client";

export interface WsEvent {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
}

const SEQ_KEY = "gmp_ws_seq";
let lastSeq = Number(sessionStorage.getItem(SEQ_KEY) ?? "0") || 0;

type EventHandler = (ev: WsEvent) => void;

export interface WsHandle {
  close: () => void;
  lastSeq: () => number;
}

/**
 * Connects to /ws, authenticates with the current access token and replays
 * missed events via sinceSeq (deduped by seq). Auto-reconnects with backoff.
 * An auth failure triggers one token refresh before retrying, so an expired
 * access token does not spin the reconnect loop forever.
 */
export function connectWs(getToken: () => string | null, onEvent: EventHandler): WsHandle {
  let ws: WebSocket | null = null;
  let closed = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let authRejected = false;
  let authFailCount = 0;

  const open = () => {
    const token = getToken();
    if (!token || closed) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      attempt = 0;
      ws?.send(JSON.stringify({ type: "auth", accessToken: token, sinceSeq: lastSeq }));
    };
    ws.onmessage = (m) => {
      let ev: {
        seq?: number;
        type?: string;
        success?: boolean;
        maxSeq?: number;
        payload?: Record<string, unknown>;
      };
      try {
        ev = JSON.parse(m.data as string);
      } catch {
        return;
      }
      if (ev.type === "auth") {
        if (ev.success) {
          authFailCount = 0;
          // Server reports the committed watermark; a stored lastSeq beyond it
          // means the DB was reset — replays would silently cover nothing and
          // every future low seq would look like a duplicate, so resync.
          if (typeof ev.maxSeq === "number" && ev.maxSeq < lastSeq) {
            lastSeq = ev.maxSeq;
            sessionStorage.setItem(SEQ_KEY, String(lastSeq));
          }
        } else {
          authRejected = true;
          authFailCount += 1;
        }
        return;
      }
      if (typeof ev.seq !== "number") return;
      if (ev.seq <= lastSeq) return; // B4: dedupe replayed events
      lastSeq = ev.seq;
      sessionStorage.setItem(SEQ_KEY, String(ev.seq));
      onEvent({ seq: ev.seq, type: ev.type ?? "", payload: ev.payload ?? {} });
    };
    ws.onclose = () => {
      if (closed) return;
      if (authRejected) {
        authRejected = false;
        // The token was rejected: refresh once, then reconnect with the new
        // token. After repeated failures give up — the next login or REST
        // request will start a fresh handle.
        if (authFailCount >= 3) return;
        void refreshToken().then(() => {
          if (!closed) open();
        });
        return;
      }
      const delay = Math.min(5000, 300 * 2 ** attempt++);
      timer = setTimeout(open, delay);
    };
    ws.onerror = () => ws?.close();
  };

  open();
  return {
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    },
    lastSeq: () => lastSeq,
  };
}
