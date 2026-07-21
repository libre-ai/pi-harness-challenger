export const MAX_RPC_LINE_BYTES = 1024 * 1024;
export const MAX_PROMPT_CHARS = 100_000;
export const MAX_SESSION_DURATION_MS = 10 * 60 * 1000;
export const MIN_SESSION_DURATION_MS = 100;

export function boundedSessionDuration(value) {
  if (value === undefined || value === "") return MAX_SESSION_DURATION_MS;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < MIN_SESSION_DURATION_MS) return MAX_SESSION_DURATION_MS;
  return Math.min(parsed, MAX_SESSION_DURATION_MS);
}

const ALLOWED_COMMANDS = new Set([
  "abort",
  "extension_ui_response",
  "follow_up",
  "get_commands",
  "get_last_assistant_text",
  "get_messages",
  "get_session_stats",
  "get_state",
  "prompt",
  "steer",
]);
const ALLOWED_EXTENSION_COMMANDS = new Set([
  "gondolin-lab-apply",
  "gondolin-lab-eval",
  "gondolin-lab-export",
  "gondolin-lab-import",
  "gondolin-lab-project-eval",
  "gondolin-lab-status",
  "policy-gate",
]);

function validIdentifier(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && /^[a-zA-Z0-9._:-]+$/.test(value);
}

function validateSlashPrompt(message) {
  const trimmed = message.trim();
  if (!trimmed.startsWith("/")) return { allowed: true };
  const [invocation, ...args] = trimmed.slice(1).split(/\s+/);
  if (!ALLOWED_EXTENSION_COMMANDS.has(invocation)) return { allowed: false, reason: "slash-command" };
  if (invocation === "policy-gate" && (args.length !== 1 || !["confirm", "enforce"].includes(args[0] ?? ""))) {
    return { allowed: false, reason: "policy-downgrade" };
  }
  if (invocation !== "policy-gate" && args.length > 0) return { allowed: false, reason: "command-arguments" };
  return { allowed: true };
}

export function inspectRpcMessage(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return { allowed: false, reason: "shape" };
  if (!ALLOWED_COMMANDS.has(message.type)) return { allowed: false, reason: "command" };
  if (message.id !== undefined && !validIdentifier(message.id)) return { allowed: false, reason: "id" };

  if (["prompt", "steer", "follow_up"].includes(message.type)) {
    if (typeof message.message !== "string" || message.message.length === 0 || message.message.length > MAX_PROMPT_CHARS) {
      return { allowed: false, reason: "prompt" };
    }
    const trimmed = message.message.trimStart();
    if (trimmed.startsWith("!")) return { allowed: false, reason: "shell-prefix" };
    if (message.type === "prompt") return validateSlashPrompt(message.message);
    if (trimmed.startsWith("/")) return { allowed: false, reason: "stream-command" };
  }

  if (message.type === "extension_ui_response") {
    if (!validIdentifier(message.id)) return { allowed: false, reason: "response-id" };
    const hasValue = typeof message.value === "string" && message.value.length <= MAX_RPC_LINE_BYTES;
    const hasConfirmation = typeof message.confirmed === "boolean";
    const hasCancellation = message.cancelled === true;
    if (![hasValue, hasConfirmation, hasCancellation].some(Boolean)) return { allowed: false, reason: "response-value" };
  }
  return { allowed: true };
}

export function normalizeRpcMessage(message) {
  const base = { type: message.type, ...(message.id ? { id: message.id } : {}) };
  if (["prompt", "steer", "follow_up"].includes(message.type)) return { ...base, message: message.message };
  if (message.type === "extension_ui_response") {
    if (typeof message.value === "string") return { ...base, value: message.value };
    if (typeof message.confirmed === "boolean") return { ...base, confirmed: message.confirmed };
    return { ...base, cancelled: true };
  }
  return base;
}

export function refusalResponse(message) {
  return {
    type: "response",
    ...(validIdentifier(message?.id) ? { id: message.id } : {}),
    command: "blocked",
    success: false,
    error: "gondolin-rpc-command-refused",
  };
}

export function parseAndInspectRpcLine(line) {
  if (!Buffer.isBuffer(line)) line = Buffer.from(String(line), "utf8");
  if (line.length === 0 || line.length > MAX_RPC_LINE_BYTES) throw new Error("gondolin-rpc-line-invalid");
  let message;
  try {
    message = JSON.parse(line.toString("utf8"));
  } catch {
    throw new Error("gondolin-rpc-json-invalid");
  }
  const decision = inspectRpcMessage(message);
  return { message: decision.allowed ? normalizeRpcMessage(message) : message, decision };
}
