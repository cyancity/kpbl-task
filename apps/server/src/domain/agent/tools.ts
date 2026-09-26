import AjvImport, { type ValidateFunction } from "ajv";

const Ajv = AjvImport as unknown as new (opts?: { allErrors?: boolean }) => {
  compile(schema: object): ValidateFunction;
  errorsText(errors?: unknown): string;
};

export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export const TOOL_DEFS: ToolDef[] = [
  {
    name: "get_recent_messages",
    description: "Return the most recent messages of the group.",
    input_schema: {
      type: "object",
      properties: { limit: { type: "number" } },
      required: ["limit"],
      additionalProperties: false,
    },
  },
  {
    name: "send_message",
    description: "Send a text message to the group.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string" },
        idempotency_key: { type: "string" },
      },
      required: ["text", "idempotency_key"],
      additionalProperties: false,
    },
  },
  {
    name: "kick_user",
    description: "Remove a member from the group by platform user id.",
    input_schema: {
      type: "object",
      properties: {
        platform_user_id: { type: "string" },
        reason: { type: "string" },
      },
      required: ["platform_user_id", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "finish",
    description: "End the run with a summary.",
    input_schema: {
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
      additionalProperties: false,
    },
  },
];

const ajv = new Ajv({ allErrors: false });
const validators = new Map<string, ValidateFunction>(
  TOOL_DEFS.map((t) => [t.name, ajv.compile(t.input_schema)]),
);

export function validateToolInput(
  name: string,
  input: unknown,
): { ok: true } | { ok: false; message: string } {
  const validate = validators.get(name);
  if (!validate) return { ok: false, message: `unknown tool ${name}` };
  if (validate(input)) return { ok: true };
  return { ok: false, message: ajv.errorsText(validate.errors) };
}
