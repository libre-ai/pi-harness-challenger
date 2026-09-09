import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
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

export const ADOPTION_JOURNAL_VERSION = 1;

const ARTIFACT_KEYS = ["controller", "pi", "pi-gondolin-rpc", "deployment.json", "launchd"];
const PHASES = new Set(["prepared", "artifacts-installed", "binding-active", "launchd-loaded", "complete"]);
const NEXT_PHASE = new Map([
  ["prepared", "artifacts-installed"],
  ["artifacts-installed", "binding-active"],
  ["binding-active", "launchd-loaded"],
  ["launchd-loaded", "complete"],
]);
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const ADOPTION_PREPARATION_PATTERN = /^\.adoption-prepare-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isOwned(stats) {
  return typeof process.getuid !== "function" || stats.uid === process.getuid();
}

function requirePrivateDirectory(path, code) {
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink() || !isOwned(stats) || (stats.mode & 0o077) !== 0) {
    throw new Error(code);
  }
}

function requirePrivateFile(path) {
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink() || !isOwned(stats) || (stats.mode & 0o077) !== 0) {
    throw new Error("adoption-journal-file-unsafe");
  }
}

function requireExactKeys(value, expected, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new Error(code);
}

function validateArtifacts(artifacts) {
  requireExactKeys(artifacts, ARTIFACT_KEYS, "adoption-journal-artifacts-invalid");
  for (const key of ARTIFACT_KEYS) {
    const entry = artifacts[key];
    requireExactKeys(entry, ["oldSha256", "newSha256"], "adoption-journal-artifacts-invalid");
    for (const field of ["oldSha256", "newSha256"]) {
      const digest = entry[field];
      const optionalLaunchdDigest = key === "launchd" && digest === "";
      if (!optionalLaunchdDigest && (typeof digest !== "string" || !DIGEST_PATTERN.test(digest))) {
        throw new Error("adoption-journal-digest-invalid");
      }
    }
  }
  return artifacts;
}

function validateJournal(journal) {
  requireExactKeys(journal, ["version", "phase", "artifacts"], "adoption-journal-schema-invalid");
  if (journal.version !== ADOPTION_JOURNAL_VERSION) throw new Error("adoption-journal-version-invalid");
  if (!PHASES.has(journal.phase)) throw new Error("adoption-journal-phase-invalid");
  validateArtifacts(journal.artifacts);
  return journal;
}

function adoptionPaths(deploymentRoot) {
  return {
    adoptionRoot: join(deploymentRoot, "adoption"),
    journalPath: join(deploymentRoot, "adoption", "journal.json"),
  };
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

function fsyncDirectory(path) {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function durableWriteJournal(adoptionRoot, journalPath, journal) {
  const temporaryPath = join(adoptionRoot, `.journal-${process.pid}-${randomUUID()}.tmp`);
  const descriptor = openSync(temporaryPath, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(journal, null, 2)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporaryPath, journalPath);
  fsyncDirectory(adoptionRoot);
}

function readJournalAt(adoptionRoot) {
  const journalPath = join(adoptionRoot, "journal.json");
  requirePrivateDirectory(adoptionRoot, "adoption-journal-directory-unsafe");
  requirePrivateFile(journalPath);
  let journal;
  try {
    journal = JSON.parse(readFileSync(journalPath, "utf8"));
  } catch {
    throw new Error("adoption-journal-json-invalid");
  }
  return validateJournal(journal);
}

function readJournal(deploymentRoot) {
  const { adoptionRoot } = adoptionPaths(deploymentRoot);
  requirePrivateDirectory(deploymentRoot, "adoption-deployment-directory-unsafe");
  return readJournalAt(adoptionRoot);
}

function removeAdoptionRoot(deploymentRoot) {
  const { adoptionRoot } = adoptionPaths(deploymentRoot);
  function makeWritable(path) {
    const stats = lstatSync(path);
    if (!isOwned(stats)) throw new Error("adoption-journal-cleanup-unsafe");
    if (stats.isSymbolicLink()) return;
    if (stats.isDirectory()) {
      chmodSync(path, 0o700);
      for (const entry of readdirSync(path)) makeWritable(join(path, entry));
    }
  }
  makeWritable(adoptionRoot);
  rmSync(adoptionRoot, { recursive: true });
  fsyncDirectory(deploymentRoot);
}

export function removeAbandonedAdoptionPreparations({ deploymentRoot }) {
  requirePrivateDirectory(deploymentRoot, "adoption-deployment-directory-unsafe");
  let removed = 0;
  for (const entry of readdirSync(deploymentRoot)) {
    if (!entry.startsWith(".adoption-prepare-")) continue;
    if (!ADOPTION_PREPARATION_PATTERN.test(entry)) throw new Error("adoption-preparation-name-invalid");
    const preparationRoot = join(deploymentRoot, entry);
    requirePrivateDirectory(preparationRoot, "adoption-preparation-directory-unsafe");
    if (readdirSync(preparationRoot).sort().join("\0") !== "journal.json") {
      throw new Error("adoption-preparation-content-invalid");
    }
    const journal = readJournalAt(preparationRoot);
    if (journal.phase !== "prepared") throw new Error("adoption-preparation-phase-invalid");
    rmSync(preparationRoot, { recursive: true });
    removed += 1;
  }
  if (removed > 0) fsyncDirectory(deploymentRoot);
  return removed;
}

export function beginRuntimeAdoption({ deploymentRoot, artifacts }) {
  requirePrivateDirectory(deploymentRoot, "adoption-deployment-directory-unsafe");
  validateArtifacts(artifacts);
  const { adoptionRoot } = adoptionPaths(deploymentRoot);
  if (pathExists(adoptionRoot)) throw new Error("adoption-journal-already-exists");
  removeAbandonedAdoptionPreparations({ deploymentRoot });
  const preparationRoot = join(deploymentRoot, `.adoption-prepare-${randomUUID()}`);
  mkdirSync(preparationRoot, { mode: 0o700 });
  chmodSync(preparationRoot, 0o700);
  requirePrivateDirectory(preparationRoot, "adoption-preparation-directory-unsafe");
  const journal = {
    version: ADOPTION_JOURNAL_VERSION,
    phase: "prepared",
    artifacts,
  };
  durableWriteJournal(preparationRoot, join(preparationRoot, "journal.json"), journal);
  renameSync(preparationRoot, adoptionRoot);
  fsyncDirectory(deploymentRoot);
  return journal;
}

export function advanceRuntimeAdoption({ deploymentRoot, expectedPhase, nextPhase }) {
  const journal = readJournal(deploymentRoot);
  if (journal.phase !== expectedPhase) throw new Error("adoption-journal-phase-mismatch");
  if (NEXT_PHASE.get(expectedPhase) !== nextPhase) throw new Error("adoption-journal-transition-invalid");
  const nextJournal = { ...journal, phase: nextPhase };
  const { adoptionRoot, journalPath } = adoptionPaths(deploymentRoot);
  durableWriteJournal(adoptionRoot, journalPath, nextJournal);
  return nextJournal;
}

function requireRecoveryCallback(callback) {
  if (typeof callback !== "function") throw new Error("adoption-journal-callback-invalid");
}

export async function recoverRuntimeAdoption({
  deploymentRoot,
  verifyInstalled,
  restoreBackups,
  finishActivation,
}) {
  const { adoptionRoot, journalPath } = adoptionPaths(deploymentRoot);
  removeAbandonedAdoptionPreparations({ deploymentRoot });
  if (!pathExists(adoptionRoot)) return "none";
  requireRecoveryCallback(verifyInstalled);
  requireRecoveryCallback(restoreBackups);
  requireRecoveryCallback(finishActivation);
  const journal = readJournal(deploymentRoot);

  if (journal.phase === "prepared") {
    await restoreBackups(journal);
    removeAdoptionRoot(deploymentRoot);
    return "rolled-back";
  }
  if (journal.phase === "complete") {
    removeAdoptionRoot(deploymentRoot);
    return "completed";
  }
  if (!await verifyInstalled(journal)) {
    await restoreBackups(journal);
    removeAdoptionRoot(deploymentRoot);
    return "rolled-back";
  }
  if (journal.phase === "artifacts-installed" || journal.phase === "binding-active") {
    await finishActivation(journal);
  }
  const completed = { ...readJournal(deploymentRoot), phase: "complete" };
  durableWriteJournal(adoptionRoot, journalPath, completed);
  removeAdoptionRoot(deploymentRoot);
  return "completed";
}
