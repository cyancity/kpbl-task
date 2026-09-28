import { useSyncExternalStore } from "react";

export interface Alert {
  id: number;
  kind: string;
  message: string;
  at: number;
}

let alerts: Alert[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((l) => l());
}

/** Surface a server-side inconsistency event to operators (spec A2). */
export function pushAlert(kind: string, message: string) {
  alerts = [...alerts.slice(-19), { id: nextId++, kind, message, at: Date.now() }];
  notify();
}

export function dismissAlert(id: number) {
  alerts = alerts.filter((a) => a.id !== id);
  notify();
}

export function useAlerts(): Alert[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => alerts,
  );
}
