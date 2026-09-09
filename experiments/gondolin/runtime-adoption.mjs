import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
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
  const directoryDescriptor = openSync(adoptionRoot, "r");
  try {
    fsyncSync(directoryDescriptor);
  } finally {
    closeSync(directoryDescriptor);
  }
}

function readJournal(deploymentRoot) {
  const { adoptionRoot, journalPath } = adoptionPaths(deploymentRoot);
  requirePrivateDirectory(deploymentRoot, "adoption-deployment-directory-unsafe");
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
}

export function beginRuntimeAdoption({ deploymentRoot, artifacts }) {
  requirePrivateDirectory(deploymentRoot, "adoption-deployment-directory-unsafe");
  validateArtifacts(artifacts);
  const { adoptionRoot, journalPath } = adoptionPaths(deploymentRoot);
  if (existsSync(adoptionRoot)) throw new Error("adoption-journal-already-exists");
  mkdirSync(adoptionRoot, { mode: 0o700 });
  requirePrivateDirectory(adoptionRoot, "adoption-journal-directory-unsafe");
  const journal = {
    version: ADOPTION_JOURNAL_VERSION,
    phase: "prepared",
    artifacts,
  };
  durableWriteJournal(adoptionRoot, journalPath, journal);
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
  if (!existsSync(adoptionRoot)) return "none";
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
