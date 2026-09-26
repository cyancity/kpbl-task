export interface AgentHttpResult {
  status: number;
  bodyText: string;
}

export class AgentTimeoutError extends Error {
  constructor() {
    super("agent request timed out");
    this.name = "AgentTimeoutError";
  }
}

async function post(
  baseUrl: string,
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<AgentHttpResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    return { status: res.status, bodyText: await res.text() };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw new AgentTimeoutError();
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export class AgentClient {
  constructor(private readonly baseUrl: string) {}

  turn(runId: string, tools: unknown, messages: unknown, timeoutMs: number) {
    return post(this.baseUrl, "/agent/turn", { runId, tools, messages }, timeoutMs);
  }

  audit(text: string, groupId: string, timeoutMs: number) {
    return post(this.baseUrl, "/agent/audit", { text, groupId }, timeoutMs);
  }
}
