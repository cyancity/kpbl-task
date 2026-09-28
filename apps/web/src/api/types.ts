import type { AccountStatus, GroupStatus, DeliveryStatus } from "@gmp/shared";

export interface Account {
  id: string;
  status: AccountStatus;
  platformUserId: string | null;
  rateLimitedUntil: string | null;
}

export interface Member {
  accountId: string;
  platformUserId: string;
  role: string;
}

export interface Group {
  id: string;
  gatewayGroupId: string | null;
  status: GroupStatus;
  creatorAccountId: string;
  agentEnabled: boolean;
  autoKickEnabled: boolean;
  members: Member[];
  activeSequenceRunId: string | null;
  activeAgentRunId: string | null;
}

export interface MessageItem {
  msgId: string | null;
  clientMsgId: string | null;
  senderPlatformUserId: string | null;
  isOwn: boolean;
  text: string | null;
  sentAt: string;
  deliveryStatus: DeliveryStatus | null;
  failCode: string | null;
}

export interface Job {
  id: string;
  kind: string;
  groupId: string | null;
  status: string;
  errors: { step: string; code: string }[];
}

export interface AgentRun {
  id: string;
  groupId: string;
  status: string;
  endReason: string | null;
  summary?: string | null;
  createdAt: string;
  endedAt?: string | null;
  steps?: AgentStep[];
}

export interface AgentStep {
  seq: number;
  kind: string;
  toolUseId: string | null;
  name: string | null;
  input: unknown;
  resultSummary: string | null;
  isError: boolean;
  errorCode: string | null;
  auditVerdict: string | null;
  rawResponse: string | null;
}

export interface Sequence {
  id: string;
  name: string;
  steps: { index: number; accountRole: "admin" | "member"; text: string; delaySeconds: number }[];
  createdAt: string;
}

export interface SequenceRun {
  id: string;
  groupId: string;
  sequenceId: string;
  status: string;
  currentStepIndex: number | null;
  steps: SequenceRunStep[];
}

export interface SequenceRunStep {
  index: number;
  status: string;
  scheduledAt: string | null;
  sentAt: string | null;
  clientMsgId: string | null;
  resolvedVars: Record<string, string>;
  varSources: Record<string, string>;
  accountId: string | null;
  text: string | null;
}
