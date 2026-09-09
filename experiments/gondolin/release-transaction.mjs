import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const RELEASE_TRANSACTION_VERSION = 1;

const PHASES = new Set(["prepared", "links-active", "qualified", "state-active", "complete"]);
const NEXT_PHASE = new Map([
  ["prepared", "links-active"],
  ["links-active", "qualified"],
  ["qualified", "state-active"],
  ["state-active", "complete"],
]);
const RECOVERY = new Map([
  ["prepared", "rollback"],
  ["links-active", "rollback"],
  ["qualified", "complete"],
  ["state-active", "complete"],
]);
const JOURNAL_KEYS = [
  "after",
  "before",
  "candidateId",
  "kind",
  "phase",
  "releaseId",
  "resolution",
  "transactionId",
  "version",
];
const SNAPSHOT_KEYS = ["current", "previous", "stateSha256"];
const RELEASE_ID_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const TRANSACTION_FILES = ["after-state.json", "before-state.json", "journal.json"];

function isOwned(stats) {
  return typeof process.getuid !== "function" || stats.uid === process.getuid();
}

function mode(stats) {
  return stats.mode & 0o777;
}

function requirePrivateDirectory(path, code = "release-transaction-directory-unsafe") {
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
    || stats.size > 1024 * 1024) {
    throw new Error("release-transaction-file-unsafe");
  }
  return stats;
}

function requireExactKeys(value, expected, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(code);
  }
}

function validateIdentifier(value, code) {
  if (typeof value !== "string" || !RELEASE_ID_PATTERN.test(value) || value === "." || value === "..") {
    throw new Error(code);
  }
  return value;
}

function validateLinkTarget(value) {
  if (value === null) return null;
  if (typeof value !== "string" || !value.startsWith("releases/")) {
    throw new Error("release-transaction-link-invalid");
  }
  const releaseId = value.slice("releases/".length);
  validateIdentifier(releaseId, "release-transaction-link-invalid");
  return value;
}

function serializeState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new Error("release-transaction-state-invalid");
  }
  return `${JSON.stringify(state, null, 2)}\n`;
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function fsyncDirectory(path) {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function durableWrite(path, content) {
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const descriptor = openSync(temporaryPath, "wx", 0o600);
  try {
    writeFileSync(descriptor, content);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporaryPath, path);
  fsyncDirectory(dirname(path));
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

function readJson(path, code) {
  requirePrivateFile(path);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(code);
  }
}

function validateSnapshot(snapshot) {
  requireExactKeys(snapshot, SNAPSHOT_KEYS, "release-transaction-snapshot-invalid");
  if (!DIGEST_PATTERN.test(snapshot.stateSha256)) throw new Error("release-transaction-snapshot-invalid");
  validateLinkTarget(snapshot.current);
  validateLinkTarget(snapshot.previous);
  return snapshot;
}

function validateJournal(journal) {
  requireExactKeys(journal, JOURNAL_KEYS, "release-transaction-schema-invalid");
  if (journal.version !== RELEASE_TRANSACTION_VERSION) throw new Error("release-transaction-version-invalid");
  if (!UUID_PATTERN.test(journal.transactionId)) throw new Error("release-transaction-id-invalid");
  if (journal.kind !== "promotion" && journal.kind !== "rollback") throw new Error("release-transaction-kind-invalid");
  if (!PHASES.has(journal.phase)) throw new Error("release-transaction-phase-invalid");
  validateIdentifier(journal.releaseId, "release-transaction-release-invalid");
  if (journal.kind === "promotion") validateIdentifier(journal.candidateId, "release-transaction-candidate-invalid");
  if (journal.kind === "rollback" && journal.candidateId !== null) {
    throw new Error("release-transaction-candidate-invalid");
  }
  if (journal.phase === "complete") {
    if (journal.resolution !== "rollback" && journal.resolution !== "complete") {
      throw new Error("release-transaction-resolution-invalid");
    }
  } else if (journal.resolution !== null) {
    throw new Error("release-transaction-resolution-invalid");
  }
  validateSnapshot(journal.before);
  validateSnapshot(journal.after);
  return journal;
}

function snapshotRecord(snapshot, serializedState) {
  requireExactKeys(snapshot, ["current", "previous", "state"], "release-transaction-snapshot-invalid");
  validateLinkTarget(snapshot.current);
  validateLinkTarget(snapshot.previous);
  return {
    stateSha256: sha256(serializedState),
    current: snapshot.current,
    previous: snapshot.previous,
  };
}

function readSafeLink(path) {
  if (!pathExists(path)) return null;
  const stats = lstatSync(path);
  if (!stats.isSymbolicLink() || !isOwned(stats)) throw new Error("release-transaction-live-state-unsafe");
  try {
    return validateLinkTarget(readlinkSync(path));
  } catch {
    throw new Error("release-transaction-live-state-unsafe");
  }
}

function liveStateHash(deploymentRoot) {
  const statePath = join(deploymentRoot, "deployment.json");
  try {
    requirePrivateFile(statePath);
    return sha256(readFileSync(statePath));
  } catch {
    throw new Error("release-transaction-live-state-unsafe");
  }
}

function requireLiveValuesKnown(deploymentRoot, before, after) {
  const current = readSafeLink(join(deploymentRoot, "current"));
  const previous = readSafeLink(join(deploymentRoot, "previous"));
  const stateSha256 = liveStateHash(deploymentRoot);
  if (![before.current, after.current].includes(current)
    || ![before.previous, after.previous].includes(previous)
    || ![before.stateSha256, after.stateSha256].includes(stateSha256)) {
    throw new Error("release-transaction-live-state-unsafe");
  }
}

function requireLiveSnapshot(deploymentRoot, snapshot) {
  if (readSafeLink(join(deploymentRoot, "current")) !== snapshot.current
    || readSafeLink(join(deploymentRoot, "previous")) !== snapshot.previous
    || liveStateHash(deploymentRoot) !== snapshot.stateSha256) {
    throw new Error("release-transaction-live-state-unsafe");
  }
}

function requireLiveLinksAndState(deploymentRoot, links, state) {
  if (readSafeLink(join(deploymentRoot, "current")) !== links.current
    || readSafeLink(join(deploymentRoot, "previous")) !== links.previous
    || liveStateHash(deploymentRoot) !== state.stateSha256) {
    throw new Error("release-transaction-live-state-unsafe");
  }
}

function atomicLink(path, target) {
  if (target === null) {
    if (pathExists(path)) rmSync(path);
    return;
  }
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  symlinkSync(target, temporaryPath);
  renameSync(temporaryPath, path);
}

function installSnapshot(deploymentRoot, snapshot, stateContent) {
  atomicLink(join(deploymentRoot, "current"), snapshot.current);
  atomicLink(join(deploymentRoot, "previous"), snapshot.previous);
  fsyncDirectory(deploymentRoot);
  durableWrite(join(deploymentRoot, "deployment.json"), stateContent);
}

function requireReleaseDirectory(path) {
  const stats = requirePrivateDirectory(path, "release-transaction-release-location-unsafe");
  return stats;
}

function validatePromotionLocation(deploymentRoot, journal, action) {
  if (journal.kind !== "promotion") return;
  const candidatePath = join(deploymentRoot, "candidates", journal.candidateId);
  const releasePath = join(deploymentRoot, "releases", journal.releaseId);
  const candidateExists = pathExists(candidatePath);
  const releaseExists = pathExists(releasePath);
  if (candidateExists) requireReleaseDirectory(candidatePath);
  if (releaseExists) requireReleaseDirectory(releasePath);
  if (action === "rollback" && candidateExists === releaseExists) {
    throw new Error("release-transaction-release-location-unsafe");
  }
  if (action === "complete" && (!releaseExists || candidateExists)) {
    throw new Error("release-transaction-release-location-unsafe");
  }
}

function recoveryAction(journal) {
  if (journal.phase === "complete") return journal.resolution;
  return RECOVERY.get(journal.phase);
}

function writeJournal(transactionRoot, journal) {
  validateJournal(journal);
  durableWrite(join(transactionRoot, "journal.json"), `${JSON.stringify(journal, null, 2)}\n`);
}

export function beginReleaseTransaction({
  deploymentRoot,
  kind,
  releaseId,
  candidateId = null,
  transactionId = randomUUID(),
  before,
  after,
}) {
  requirePrivateDirectory(deploymentRoot, "release-transaction-deployment-unsafe");
  const transactionRoot = join(deploymentRoot, "release-transaction");
  if (pathExists(transactionRoot)) throw new Error("release-transaction-already-exists");
  const beforeState = serializeState(before?.state);
  const afterState = serializeState(after?.state);
  const journal = validateJournal({
    version: RELEASE_TRANSACTION_VERSION,
    transactionId,
    kind,
    phase: "prepared",
    releaseId,
    candidateId,
    resolution: null,
    before: snapshotRecord(before, beforeState),
    after: snapshotRecord(after, afterState),
  });
  requireLiveSnapshot(deploymentRoot, journal.before);

  const preparationRoot = join(deploymentRoot, `.release-transaction-prepare-${journal.transactionId}`);
  mkdirSync(preparationRoot, { mode: 0o700 });
  chmodSync(preparationRoot, 0o700);
  requirePrivateDirectory(preparationRoot);
  durableWrite(join(preparationRoot, "before-state.json"), beforeState);
  durableWrite(join(preparationRoot, "after-state.json"), afterState);
  writeJournal(preparationRoot, journal);
  renameSync(preparationRoot, transactionRoot);
  fsyncDirectory(deploymentRoot);
  return journal;
}

export function inspectReleaseTransaction({ deploymentRoot }) {
  requirePrivateDirectory(deploymentRoot, "release-transaction-deployment-unsafe");
  const transactionRoot = join(deploymentRoot, "release-transaction");
  if (!pathExists(transactionRoot)) return null;
  requirePrivateDirectory(transactionRoot);
  if (readdirSync(transactionRoot).sort().join("\0") !== TRANSACTION_FILES.join("\0")) {
    throw new Error("release-transaction-content-invalid");
  }
  const journal = validateJournal(readJson(join(transactionRoot, "journal.json"), "release-transaction-json-invalid"));
  const beforeStatePath = join(transactionRoot, "before-state.json");
  const afterStatePath = join(transactionRoot, "after-state.json");
  requirePrivateFile(beforeStatePath);
  requirePrivateFile(afterStatePath);
  const beforeStateContent = readFileSync(beforeStatePath, "utf8");
  const afterStateContent = readFileSync(afterStatePath, "utf8");
  const beforeState = readJson(beforeStatePath, "release-transaction-state-invalid");
  const afterState = readJson(afterStatePath, "release-transaction-state-invalid");
  if (sha256(beforeStateContent) !== journal.before.stateSha256
    || sha256(afterStateContent) !== journal.after.stateSha256) {
    throw new Error("release-transaction-state-hash-invalid");
  }
  return {
    journal,
    before: { ...journal.before, state: beforeState, stateContent: beforeStateContent },
    after: { ...journal.after, state: afterState, stateContent: afterStateContent },
  };
}

export function advanceReleaseTransaction({ deploymentRoot, expectedPhase, nextPhase }) {
  const transaction = inspectReleaseTransaction({ deploymentRoot });
  if (transaction === null) throw new Error("release-transaction-required");
  if (transaction.journal.phase !== expectedPhase) throw new Error("release-transaction-phase-mismatch");
  if (NEXT_PHASE.get(expectedPhase) !== nextPhase) throw new Error("release-transaction-transition-invalid");
  if (nextPhase === "links-active" || nextPhase === "qualified") {
    requireLiveLinksAndState(deploymentRoot, transaction.after, transaction.before);
  } else {
    requireLiveSnapshot(deploymentRoot, transaction.after);
  }
  const journal = {
    ...transaction.journal,
    phase: nextPhase,
    resolution: nextPhase === "complete" ? "complete" : null,
  };
  writeJournal(join(deploymentRoot, "release-transaction"), journal);
  return journal;
}

export function recoverReleaseTransaction({ deploymentRoot }) {
  const transaction = inspectReleaseTransaction({ deploymentRoot });
  if (transaction === null) return { action: "none", transactionId: null };
  const action = recoveryAction(transaction.journal);
  const target = action === "rollback" ? transaction.before : transaction.after;
  requireLiveValuesKnown(deploymentRoot, transaction.before, transaction.after);
  validatePromotionLocation(deploymentRoot, transaction.journal, action);
  installSnapshot(deploymentRoot, target, target.stateContent);

  if (action === "rollback" && transaction.journal.kind === "promotion") {
    const candidatePath = join(deploymentRoot, "candidates", transaction.journal.candidateId);
    const releasePath = join(deploymentRoot, "releases", transaction.journal.releaseId);
    if (pathExists(releasePath)) {
      renameSync(releasePath, candidatePath);
      fsyncDirectory(join(deploymentRoot, "releases"));
      fsyncDirectory(join(deploymentRoot, "candidates"));
    }
  }
  return { action, transactionId: transaction.journal.transactionId };
}

export function completeReleaseTransaction({ deploymentRoot, transactionId }) {
  const transaction = inspectReleaseTransaction({ deploymentRoot });
  if (transaction === null || transaction.journal.transactionId !== transactionId) {
    throw new Error("release-transaction-id-mismatch");
  }
  const action = recoveryAction(transaction.journal);
  const target = action === "rollback" ? transaction.before : transaction.after;
  requireLiveSnapshot(deploymentRoot, target);
  validatePromotionLocation(deploymentRoot, transaction.journal, action);
  if (transaction.journal.phase !== "complete") {
    writeJournal(join(deploymentRoot, "release-transaction"), {
      ...transaction.journal,
      phase: "complete",
      resolution: action,
    });
  }
  rmSync(join(deploymentRoot, "release-transaction"), { recursive: true });
  fsyncDirectory(deploymentRoot);
  return { completed: true, action, transactionId };
}
