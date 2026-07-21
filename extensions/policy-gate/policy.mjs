import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve, sep } from "node:path";
import { getActiveSandboxCapability } from "./capabilities.mjs";
import {
  DEFAULT_POLICY_MODE,
  POLICY_MODES,
  normalizePolicyMode,
} from "../shared/config.mjs";

export const MODES = POLICY_MODES;
export const DEFAULT_MODE = DEFAULT_POLICY_MODE;
export const RISK_LEVELS = Object.freeze({ R0: 0, R1: 1, R2: 2, R3: 3 });

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const MUTATING_TOOLS = new Set(["write", "edit"]);
const LOW_RISK_EXTERNAL_TOOLS = new Set(["resolve-library-id", "query-docs"]);

const READ_ONLY_COMMANDS = [
  /^pwd$/i,
  /^(?:ls|cat|head|tail|wc|stat|file|du)(?:\s+[^\n\r;&|><`$()]*)?$/i,
  /^git(?:\s+-C\s+\S+)?\s+(?:status|diff|log|show|rev-parse|ls-files)(?:\s+[^\n\r;&|><`$()]*)?$/i,
];

const R3_PATTERNS = [
  { code: "force-push", summary: "push forcé", deny: true, pattern: /\bgit(?:\s+-C\s+(?:"[^"]*"|'[^']*'|\S+))?\s+push\b[^\n;&|]*(?:--force(?:-with-lease)?|-f\b)/i },
  { code: "git-push", summary: "publication Git distante", pattern: /\bgit(?:\s+-C\s+(?:"[^"]*"|'[^']*'|\S+))?\s+push\b/i },
  { code: "recursive-delete", summary: "suppression récursive", deny: true, pattern: /\brm\b[^\n;&|]*(?:-[a-z]*r[a-z]*f?|-[a-z]*f[a-z]*r|--recursive)\b/i },
  { code: "git-reset-hard", summary: "réinitialisation Git destructive", deny: true, pattern: /\bgit(?:\s+-C\s+\S+)?\s+reset\s+--hard\b/i },
  { code: "git-clean-force", summary: "nettoyage Git destructif", deny: true, pattern: /\bgit(?:\s+-C\s+\S+)?\s+clean\b[^\n;&|]*-[a-z]*f/i },
  { code: "database-destroy", summary: "destruction de structure de données", deny: true, pattern: /\b(?:drop\s+(?:database|schema|table)|truncate\s+table)\b/i },
  { code: "infrastructure-destroy", summary: "destruction d’infrastructure", deny: true, pattern: /\b(?:terraform|tofu)\s+destroy\b/i },
  { code: "package-publish", summary: "publication ou retrait de package", pattern: /\b(?:npm|pnpm)\s+(?:publish|unpublish)\b|\bcargo\s+(?:publish|yank)\b|\byarn\s+npm\s+(?:publish|unpublish)\b/i },
  { code: "image-push", summary: "publication d’image", pattern: /\b(?:docker|podman)\s+push\b/i },
  { code: "deployment", summary: "déploiement externe", pattern: /\b(?:cc|clever)\s+deploy\b|\b(?:kubectl|helm)\s+(?:apply|delete|patch|replace|scale|rollout|install|upgrade|uninstall)\b|\b(?:terraform|tofu)\s+apply\b/i },
  { code: "forge-mutation", summary: "mutation sur une forge distante", pattern: /\b(?:gh\s+(?:pr|issue)|glab\s+(?:mr|issue))\s+(?:create|merge|close|delete|reopen)\b/i },
  { code: "forge-api-mutation", summary: "mutation via l’API d’une forge", pattern: /\b(?:gh|glab)\s+api\b[^\n;&|]*(?:(?:-X|--method)\s*(?:POST|PUT|PATCH|DELETE)\b|(?:-f|-F|--field|--raw-field)(?:\s|=))/i },
  { code: "remote-shell", summary: "exécution ou copie distante", pattern: /(?:^|[;&|]\s*|\s)(?:ssh|scp|sftp)\s+/i },
  { code: "http-mutation", summary: "requête HTTP avec effet de bord", pattern: /\bcurl\b[^\n;&|]*(?:-X|--request)\s*(?:POST|PUT|PATCH|DELETE)\b|\bcurl\b[^\n;&|]*(?:--data(?:-[a-z-]+)?|-d|-F|--form(?:-string)?|--json|--upload-file|-T)(?:\s|=)/i },
  { code: "message-send", summary: "envoi de message externe", pattern: /(?:^|[;&|]\s*|\s)(?:mail|sendmail)\s+/i },
];

const R2_PATTERNS = [
  { code: "privilege-escalation", summary: "élévation de privilèges", pattern: /(?:^|[;&|]\s*|\s)(?:sudo|doas)\s+/i },
  { code: "local-delete", summary: "suppression locale", pattern: /(?:^|[;&|]\s*|\s)rm\s+/i },
  { code: "permission-change", summary: "modification de permissions ou propriétaire", pattern: /(?:^|[;&|]\s*|\s)(?:chmod|chown)\s+/i },
  { code: "process-signal", summary: "arrêt forcé de processus", pattern: /(?:^|[;&|]\s*|\s)(?:kill|pkill|killall)\s+/i },
  { code: "git-worktree-discard", summary: "abandon de changements Git locaux", pattern: /\bgit(?:\s+-C\s+\S+)?\s+(?:restore\b|checkout\s+--\b|stash\s+(?:drop|clear)\b|branch\s+-D\b)/i },
  { code: "raw-device-write", summary: "écriture brute sur périphérique", pattern: /(?:^|[;&|]\s*|\s)(?:dd|mkfs(?:\.\w+)?)\s+/i },
];

const SENSITIVE_COMMAND_PATTERNS = [
  /(?:^|[\/\s'"=])\.env(?:\.[\w.-]+)?(?=$|[\s'";&|<>])/i,
  /(?:^|[\/\s'"=])(?:auth\.json|credentials(?:\.json)?|\.npmrc|\.pypirc|\.netrc)(?=$|[\s'";&|<>])/i,
  /(?:^|[\/])\.(?:ssh|gnupg|aws|kube)(?:[\/\s'"]|$)/i,
  /(?:^|[\/\s'"])(?:id_rsa|id_ed25519|id_ecdsa|id_dsa|[^\/\s'"]+\.(?:key|pem|p12|pfx))(?=$|[\s'";&|<>])/i,
];

function uniqueFindings(findings) {
  const seen = new Set();
  return findings.filter((finding) => {
    if (seen.has(finding.code)) return false;
    seen.add(finding.code);
    return true;
  });
}

function highestRisk(current, candidate) {
  return RISK_LEVELS[candidate] > RISK_LEVELS[current] ? candidate : current;
}

export const normalizeMode = normalizePolicyMode;

export function canonicalizePath(path, cwd = process.cwd()) {
  const raw = String(path ?? "").replace(/^@(?=\S)/, "");
  const absolute = resolve(cwd, raw);
  let cursor = absolute;
  const missing = [];

  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    missing.unshift(basename(cursor));
    cursor = parent;
  }

  try {
    const realBase = realpathSync.native(cursor);
    return resolve(realBase, ...missing);
  } catch {
    return absolute;
  }
}

export function inspectSensitivePath(path, cwd = process.cwd()) {
  const canonicalPath = canonicalizePath(path, cwd);
  const parts = canonicalPath.split(sep).filter(Boolean);
  const lowerParts = parts.map((part) => part.toLowerCase());
  const name = (parts.at(-1) ?? "").toLowerCase();
  const parentName = (parts.at(-2) ?? "").toLowerCase();

  if (lowerParts.includes(".git")) {
    return { code: "git-metadata", summary: "métadonnées Git protégées", canonicalPath };
  }
  if (lowerParts.some((part) => [".ssh", ".gnupg", ".aws", ".kube"].includes(part))) {
    return { code: "credential-directory", summary: "répertoire de credentials", canonicalPath };
  }
  if (/^\.env(?:\.|$)/i.test(name)) {
    return { code: "environment-file", summary: "fichier d’environnement sensible", canonicalPath };
  }
  if (["auth.json", "credentials", "credentials.json", ".npmrc", ".pypirc", ".netrc"].includes(name)) {
    return { code: "credential-file", summary: "fichier de credentials", canonicalPath };
  }
  if (/^(?:id_rsa|id_ed25519|id_ecdsa|id_dsa)$/.test(name) || /\.(?:key|pem|p12|pfx)$/.test(name)) {
    return { code: "private-key", summary: "clé privée ou certificat sensible", canonicalPath };
  }
  if (parentName === ".docker" && name === "config.json") {
    return { code: "credential-file", summary: "configuration Docker avec credentials potentiels", canonicalPath };
  }

  return undefined;
}

export function classifyCommand(command) {
  const source = String(command ?? "").trim();
  let risk = "R1";
  let enforceDeny = false;
  const findings = [];

  for (const item of R3_PATTERNS) {
    if (!item.pattern.test(source)) continue;
    risk = highestRisk(risk, "R3");
    enforceDeny ||= item.deny === true;
    findings.push({ code: item.code, summary: item.summary, risk: "R3" });
  }

  for (const item of R2_PATTERNS) {
    if (!item.pattern.test(source)) continue;
    risk = highestRisk(risk, "R2");
    findings.push({ code: item.code, summary: item.summary, risk: "R2" });
  }

  if (SENSITIVE_COMMAND_PATTERNS.some((pattern) => pattern.test(source))) {
    risk = highestRisk(risk, "R2");
    findings.push({ code: "sensitive-path", summary: "référence à une cible sensible", risk: "R2" });
  }

  if (findings.length === 0 && READ_ONLY_COMMANDS.some((pattern) => pattern.test(source))) {
    risk = "R0";
    findings.push({ code: "read-only-command", summary: "commande de consultation reconnue", risk: "R0" });
  }

  if (findings.length === 0) {
    risk = "R2";
    findings.push({ code: "generic-shell", summary: "commande shell non classifiée, confirmation requise", risk: "R2" });
  }

  return {
    risk,
    level: RISK_LEVELS[risk],
    findings: uniqueFindings(findings),
    enforceDeny,
  };
}

export function classifyToolCall({ toolName, input = {}, cwd = process.cwd() }) {
  const normalizedTool = String(toolName ?? "").replace(/^functions\./, "").toLowerCase();
  const path = typeof input.path === "string" ? input.path : undefined;
  const targets = [];
  const findings = [];
  let risk = "R1";
  let enforceDeny = false;

  if (normalizedTool === "bash") {
    const sandbox = getActiveSandboxCapability(normalizedTool);
    if (sandbox) {
      return {
        toolName: normalizedTool,
        risk: "R1",
        level: RISK_LEVELS.R1,
        findings: [{ code: "sandboxed-shell", summary: `shell isolé par ${sandbox.backend}`, risk: "R1" }],
        targets,
        enforceDeny: false,
        sandbox,
      };
    }
    const commandResult = classifyCommand(input.command);
    return {
      toolName: normalizedTool,
      ...commandResult,
      targets,
    };
  }

  if (path !== undefined) {
    const sensitive = inspectSensitivePath(path, cwd);
    const canonicalPath = sensitive?.canonicalPath ?? canonicalizePath(path, cwd);
    targets.push(canonicalPath);

    if (sensitive) {
      risk = "R2";
      findings.push({ code: sensitive.code, summary: sensitive.summary, risk: "R2" });
      enforceDeny = MUTATING_TOOLS.has(normalizedTool);
    }
  }

  if (READ_ONLY_TOOLS.has(normalizedTool)) {
    if (findings.length === 0) {
      risk = "R0";
      findings.push({ code: "read-only-tool", summary: "outil de consultation", risk: "R0" });
    }
  } else if (MUTATING_TOOLS.has(normalizedTool)) {
    if (findings.length === 0) {
      risk = "R1";
      findings.push({ code: "local-mutation", summary: "mutation locale ciblée", risk: "R1" });
    }
  } else if (LOW_RISK_EXTERNAL_TOOLS.has(normalizedTool)) {
    risk = "R1";
    findings.push({ code: "document-query", summary: "requête documentaire externe", risk: "R1" });
  } else if (/(?:^|[_-])(?:deploy|publish|push|release|send|destroy|delete|create[-_]?(?:mr|pr))(?:$|[_-])/.test(normalizedTool)) {
    risk = "R3";
    findings.push({ code: "external-mutation-tool", summary: "outil à effet externe potentiel", risk: "R3" });
  } else if (findings.length === 0) {
    risk = "R2";
    findings.push({ code: "unknown-tool", summary: "outil sans capacité déclarée, confirmation requise", risk: "R2" });
  }

  return {
    toolName: normalizedTool,
    risk,
    level: RISK_LEVELS[risk],
    findings: uniqueFindings(findings),
    targets,
    enforceDeny,
  };
}

export function redactText(value, maxLength = 320) {
  let text = String(value ?? "");
  text = text.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi, "<private-key:redacted>");
  text = text.replace(/(['"])(?:authorization|x-api-key)\s*:[^'"]*\1/gi, "$1<auth-header:redacted>$1");
  text = text.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 <redacted>");
  text = text.replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|CREDENTIAL)[A-Z0-9_]*)=(?:"[^"]*"|'[^']*'|[^\s]+)/gi, "$1=<redacted>");
  text = text.replace(/(--(?:api[-_]?key|token|password|secret|authorization|user)|-u)(?:=|\s+)(?:"[^"]*"|'[^']*'|[^\s]+)/gi, "$1=<redacted>");
  text = text.replace(/((?:authorization|x-api-key)\s*:\s*)(?:Bearer\s+|Basic\s+)?[^\s'";]+/gi, "$1<redacted>");
  text = text.replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1<credentials:redacted>@");
  text = text.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "<email:redacted>");
  text = text.split(homedir()).join("~");
  text = text.replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

export function redactPath(path) {
  const value = String(path ?? "");
  const home = homedir();
  if (value === home) return "~";
  if (value.startsWith(`${home}${sep}`)) return `~${value.slice(home.length)}`;
  return value;
}

export function decidePreflight({ mode, classification, hasUI }) {
  const normalizedMode = normalizeMode(mode);
  if (!normalizedMode) return { action: "block", reason: "invalid-mode" };
  if (normalizedMode === "off" || normalizedMode === "observe" || classification.level < 2) {
    return { action: "allow" };
  }
  if (normalizedMode === "enforce" && classification.enforceDeny) {
    return { action: "block", reason: "enforce-deny" };
  }
  if (!hasUI) return { action: "block", reason: "confirmation-unavailable" };
  return { action: "confirm" };
}

export function createCounters() {
  return {
    seen: { R0: 0, R1: 0, R2: 0, R3: 0 },
    observed: 0,
    confirmed: 0,
    blocked: 0,
    allowed: 0,
    errors: 0,
  };
}

export function recordDecision(counters, classification, decision) {
  counters.seen[classification.risk] += 1;
  if (decision in counters && typeof counters[decision] === "number") {
    counters[decision] += 1;
  }
  return counters;
}

export function formatStatus(mode, counters) {
  return `policy: ${mode} · R2 ${counters.seen.R2} · R3 ${counters.seen.R3} · bloquées ${counters.blocked}`;
}

export function formatConfirmation(classification, input = {}) {
  const reasons = classification.findings.map((finding) => finding.summary).join(", ");
  const targets = classification.targets.map(redactPath);
  const lines = [`Risque ${classification.risk} — ${reasons}.`];

  if (classification.toolName === "bash") {
    lines.push(`Commande : ${redactText(input.command)}`);
  }
  if (targets.length > 0) {
    lines.push(`Cible : ${targets.join(", ")}`);
  }
  lines.push("Autoriser cette opération une fois ?");
  return lines.join("\n");
}
