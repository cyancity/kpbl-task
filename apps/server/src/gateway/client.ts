export class GatewayError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly body: unknown,
  ) {
    super(`gateway error ${status} ${code}`);
    this.name = "GatewayError";
  }
}

interface GatewayRequestOptions {
  method?: string;
  body?: unknown;
}

export class GatewayClient {
  constructor(private readonly baseUrl: string) {}

  private async request<T>(path: string, opts: GatewayRequestOptions = {}): Promise<T> {
    const init: RequestInit = { method: opts.method ?? "GET" };
    if (opts.body !== undefined) {
      init.headers = { "content-type": "application/json" };
      init.body = JSON.stringify(opts.body);
    }
    const res = await fetch(`${this.baseUrl}${path}`, init);
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const errObj =
        json && typeof json === "object" && "error" in json
          ? (json as { error: { code?: string } }).error
          : json && typeof json === "object" && "code" in json
            ? (json as { code?: string })
            : null;
      throw new GatewayError(res.status, errObj?.code ?? `HTTP_${res.status}`, json);
    }
    return json as T;
  }

  connect(accountId: string) {
    return this.request<{ platformUserId: string }>(`/accounts/${accountId}/connect`, {
      method: "POST",
    });
  }

  disconnect(accountId: string) {
    return this.request<Record<string, never>>(`/accounts/${accountId}/disconnect`, {
      method: "POST",
    });
  }

  createGroup(creatorAccountId: string) {
    return this.request<{ groupId: string }>(`/groups`, {
      method: "POST",
      body: { creatorAccountId },
    });
  }

  invite(groupId: string) {
    return this.request<{ inviteLink: string; readyAfterMs: number }>(`/groups/${groupId}/invite`, {
      method: "POST",
    });
  }

  join(groupId: string, accountId: string, inviteLink: string) {
    return this.request<{ accepted: boolean }>(`/groups/${groupId}/join`, {
      method: "POST",
      body: { accountId, inviteLink },
    });
  }

  promote(groupId: string, byAccountId: string, accountId: string) {
    return this.request<Record<string, never>>(`/groups/${groupId}/promote`, {
      method: "POST",
      body: { byAccountId, accountId },
    });
  }

  kick(groupId: string, byAccountId: string, targetPlatformUserId: string) {
    return this.request<{ kicked: boolean }>(`/groups/${groupId}/kick`, {
      method: "POST",
      body: { byAccountId, targetPlatformUserId },
    });
  }

  leave(groupId: string, accountId: string) {
    return this.request<Record<string, never>>(`/groups/${groupId}/leave`, {
      method: "POST",
      body: { accountId },
    });
  }

  members(groupId: string) {
    return this.request<Array<{ platformUserId: string }>>(`/groups/${groupId}/members`);
  }

  send(groupId: string, accountId: string, clientMsgId: string, text: string) {
    return this.request<{ accepted: boolean }>(`/groups/${groupId}/send`, {
      method: "POST",
      body: { accountId, clientMsgId, text },
    });
  }

  messageByClientId(groupId: string, clientMsgId: string) {
    return this.request<{ msgId: string; sentAt: string }>(
      `/groups/${groupId}/messages/by-client-id/${clientMsgId}`,
    );
  }

  media(mediaId: string) {
    return this.request<unknown>(`/media/${mediaId}`);
  }
}
