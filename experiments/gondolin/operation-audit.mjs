import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const AUDIT_RECORD_VERSION = 1;
export const AUDIT_COMPLETED_RETENTION = 256;

const ACTIONS = new Set([
  "release-update",
  "release-rollback",
  "runtime-repin",
  "runtime-adoption",
  "automation-enable",
  "automation-disable",
]);
const TRIGGERS = new Set(["manual", "automatic", "recovery"]);
const OUTCOMES = new Set(["succeeded", "refused", "recovered"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTIFIER_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/;
const ERROR_CODE_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const STARTED_KEYS = ["action", "operationId", "startedAt", "targetId", "trigger", "version"];
const RESULT_KEYS = ["completedAt", "errorCode", "operationId", "outcome", "version"];
const BEGIN_KEYS = ["action", "deploymentRoot", "startedAt", "targetId", "trigger"];
const COMPLETE_KEYS = ["completedAt", "deploymentRoot", "errorCode", "operationId", "outcome"];
const PERSISTENCE_ERROR_CODES = new Set([
  "EACCES",
  "EDQUOT",
  "EIO",
  "EMFILE",
  "ENFILE",
  "ENOSPC",
  "EPERM",
  "EROFS",
]);

function isOwned(stats) {
  return typeof process.getuid !== "function" || stats.uid === process.getuid();
}

function mode(stats) {
  return stats.mode & 0o777;
}

function pathExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function requirePrivateDirectory(path, code = "audit-directory-unsafe") {
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink() || !isOwned(stats) || mode(stats) !== 0o700) {
    throw new Error(code);
  }
  return stats;
}

function requirePrivateFile(path) {
  const stats = lstatSync(path);
  if (!stats.isFile()
    || stats.isSymbolicLink()
    || !isOwned(stats)
    || mode(stats) !== 0o600
    || stats.size > 16 * 1024) {
    throw new Error("audit-file-unsafe");
  }
}

function ensurePrivateDirectory(path) {
  if (pathExists(path)) {
    requirePrivateDirectory(path);
    return;
  }
  mkdirSync(path, { mode: 0o700 });
  chmodSync(path, 0o700);
  requirePrivateDirectory(path);
}

function fsyncDirectory(path) {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeDurableFile(path, content) {
  const descriptor = openSync(path, "wx", 0o600);
  try {
    writeFileSync(descriptor, content);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function requireExactKeys(value, expected, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(code);
  }
}

function requireAllowedKeys(value, allowed, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(code);
}

function validateTimestamp(value, code) {
  if (typeof value !== "string") throw new Error(code);
  const date = new Date(value);
  if (Number.isNaN(date.valueOf()) || date.toISOString() !== value) throw new Error(code);
  return value;
}

function validateTargetId(value) {
  if (value !== null && (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value))) {
    throw new Error("audit-target-invalid");
  }
  return value;
}

function validateErrorCode(value) {
  if (value !== null && (typeof value !== "string" || !ERROR_CODE_PATTERN.test(value))) {
    throw new Error("audit-error-code-invalid");
  }
  return value;
}

function validateStarted(record) {
  requireExactKeys(record, STARTED_KEYS, "audit-started-schema-invalid");
  if (record.version !== AUDIT_RECORD_VERSION) throw new Error("audit-version-invalid");
  if (!UUID_PATTERN.test(record.operationId)) throw new Error("audit-operation-id-invalid");
  if (!ACTIONS.has(record.action)) throw new Error("audit-action-invalid");
  if (!TRIGGERS.has(record.trigger)) throw new Error("audit-trigger-invalid");
  validateTargetId(record.targetId);
  validateTimestamp(record.startedAt, "audit-started-at-invalid");
  return record;
}

function validateResult(record, operationId) {
  requireExactKeys(record, RESULT_KEYS, "audit-result-schema-invalid");
  if (record.version !== AUDIT_RECORD_VERSION) throw new Error("audit-version-invalid");
  if (record.operationId !== operationId || !UUID_PATTERN.test(record.operationId)) {
    throw new Error("audit-operation-id-invalid");
  }
  if (!OUTCOMES.has(record.outcome)) throw new Error("audit-outcome-invalid");
  validateErrorCode(record.errorCode);
  validateTimestamp(record.completedAt, "audit-completed-at-invalid");
  return record;
}

function readJson(path, code) {
  requirePrivateFile(path);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(code);
  }
}

function auditPaths(deploymentRoot) {
  const auditRoot = join(deploymentRoot, "audit");
  return { auditRoot, operationsRoot: join(auditRoot, "operations") };
}

function ensureAuditRoots(deploymentRoot) {
  requirePrivateDirectory(deploymentRoot, "audit-deployment-directory-unsafe");
  const paths = auditPaths(deploymentRoot);
  ensurePrivateDirectory(paths.auditRoot);
  ensurePrivateDirectory(paths.operationsRoot);
  return paths;
}

function readOperation(operationsRoot, operationId) {
  if (!UUID_PATTERN.test(operationId)) throw new Error("audit-operation-id-invalid");
  const operationRoot = join(operationsRoot, operationId);
  requirePrivateDirectory(operationRoot, "audit-operation-directory-unsafe");
  const entries = readdirSync(operationRoot).sort();
  if (entries.join("\0") !== "started.json" && entries.join("\0") !== "result.json\0started.json") {
    throw new Error("audit-operation-content-invalid");
  }
  const started = validateStarted(readJson(join(operationRoot, "started.json"), "audit-started-json-invalid"));
  if (started.operationId !== operationId) throw new Error("audit-operation-id-invalid");
  const result = entries.includes("result.json")
    ? validateResult(readJson(join(operationRoot, "result.json"), "audit-result-json-invalid"), operationId)
    : null;
  return { operationId, operationRoot, started, result, stats: lstatSync(operationRoot) };
}

function readAllOperations(deploymentRoot) {
  requirePrivateDirectory(deploymentRoot, "audit-deployment-directory-unsafe");
  const { auditRoot, operationsRoot } = auditPaths(deploymentRoot);
  if (!pathExists(auditRoot)) return [];
  requirePrivateDirectory(auditRoot);
  requirePrivateDirectory(operationsRoot);
  return readdirSync(operationsRoot)
    .sort()
    .map((operationId) => readOperation(operationsRoot, operationId));
}

export function beginAuditOperation(input) {
  requireAllowedKeys(input, BEGIN_KEYS, "audit-begin-input-invalid");
  const {
    deploymentRoot,
    action,
    trigger,
    targetId = null,
    startedAt = new Date().toISOString(),
  } = input;
  if (!ACTIONS.has(action)) throw new Error("audit-action-invalid");
  if (!TRIGGERS.has(trigger)) throw new Error("audit-trigger-invalid");
  validateTargetId(targetId);
  validateTimestamp(startedAt, "audit-started-at-invalid");
  const { operationsRoot } = ensureAuditRoots(deploymentRoot);
  const operationId = randomUUID();
  const record = validateStarted({
    version: AUDIT_RECORD_VERSION,
    operationId,
    action,
    trigger,
    targetId,
    startedAt,
  });
  const preparationRoot = join(operationsRoot, `.operation-${operationId}`);
  const operationRoot = join(operationsRoot, operationId);
  mkdirSync(preparationRoot, { mode: 0o700 });
  chmodSync(preparationRoot, 0o700);
  requirePrivateDirectory(preparationRoot, "audit-operation-directory-unsafe");
  try {
    writeDurableFile(join(preparationRoot, "started.json"), `${JSON.stringify(record, null, 2)}\n`);
    fsyncDirectory(preparationRoot);
    renameSync(preparationRoot, operationRoot);
    fsyncDirectory(operationsRoot);
  } catch (error) {
    if (pathExists(preparationRoot)) rmSync(preparationRoot, { recursive: true });
    throw error;
  }
  return { operationId, auditComplete: false };
}

export function completeAuditOperation(input) {
  requireAllowedKeys(input, COMPLETE_KEYS, "audit-complete-input-invalid");
  const {
    deploymentRoot,
    operationId,
    outcome,
    errorCode = null,
    completedAt = new Date().toISOString(),
  } = input;
  if (!OUTCOMES.has(outcome)) throw new Error("audit-outcome-invalid");
  validateErrorCode(errorCode);
  validateTimestamp(completedAt, "audit-completed-at-invalid");
  const { operationsRoot } = auditPaths(deploymentRoot);
  requirePrivateDirectory(deploymentRoot, "audit-deployment-directory-unsafe");
  const operation = readOperation(operationsRoot, operationId);
  if (completedAt < operation.started.startedAt) throw new Error("audit-completed-before-start");
  if (operation.result !== null) {
    if (operation.result.outcome !== outcome || operation.result.errorCode !== errorCode) {
      throw new Error("audit-result-conflict");
    }
    return { operationId, auditComplete: true };
  }

  const result = validateResult({
    version: AUDIT_RECORD_VERSION,
    operationId,
    outcome,
    errorCode,
    completedAt,
  }, operationId);
  const temporaryPath = join(operation.operationRoot, `.result-${randomUUID()}.tmp`);
  const resultPath = join(operation.operationRoot, "result.json");
  try {
    writeDurableFile(temporaryPath, `${JSON.stringify(result, null, 2)}\n`);
    linkSync(temporaryPath, resultPath);
    rmSync(temporaryPath);
    fsyncDirectory(operation.operationRoot);
    return { operationId, auditComplete: true };
  } catch (error) {
    if (pathExists(temporaryPath)) rmSync(temporaryPath);
    if (error?.code === "EEXIST") {
      const concurrent = readOperation(operationsRoot, operationId).result;
      if (concurrent?.outcome === outcome && concurrent.errorCode === errorCode) {
        return { operationId, auditComplete: true };
      }
      throw new Error("audit-result-conflict");
    }
    if (PERSISTENCE_ERROR_CODES.has(error?.code)) return { operationId, auditComplete: false };
    throw error;
  }
}

export function auditStatus({ deploymentRoot }) {
  const operations = readAllOperations(deploymentRoot);
  const incompleteOperationIds = operations
    .filter((operation) => operation.result === null)
    .map((operation) => operation.operationId);
  return {
    completed: operations.length - incompleteOperationIds.length,
    incomplete: incompleteOperationIds.length,
    incompleteOperationIds,
  };
}

export function pruneCompletedAuditOperations({ deploymentRoot }) {
  const completed = readAllOperations(deploymentRoot)
    .filter((operation) => operation.result !== null)
    .sort((left, right) => left.result.completedAt.localeCompare(right.result.completedAt)
      || left.operationId.localeCompare(right.operationId));
  const removeCount = Math.max(0, completed.length - AUDIT_COMPLETED_RETENTION);
  for (const operation of completed.slice(0, removeCount)) {
    const current = requirePrivateDirectory(operation.operationRoot, "audit-operation-directory-unsafe");
    if (current.dev !== operation.stats.dev || current.ino !== operation.stats.ino) {
      throw new Error("audit-operation-replaced");
    }
    rmSync(operation.operationRoot, { recursive: true });
  }
  if (removeCount > 0) fsyncDirectory(auditPaths(deploymentRoot).operationsRoot);
  return removeCount;
}
