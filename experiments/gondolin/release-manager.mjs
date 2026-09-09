import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const INTEGRITY_PATTERN = /^sha512-[0-9A-Za-z+/=_-]+$/;
const RELEASE_ID_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/;
const MANIFEST_LINE_PATTERN = /^([a-f0-9]{64})  (.+)$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UPDATE_LOCK_OWNER_KEYS = ["acquiredAt", "nonce", "pid", "version"];
const UPDATE_LOCK_RETRIES = 3;

function isOwned(stats) {
  return typeof process.getuid !== "function" || stats.uid === process.getuid();
}

function ensureOwnedDirectory(path, mode = 0o700) {
  mkdirSync(path, { recursive: true, mode });
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink() || !isOwned(stats)) {
    throw new Error("directory-unsafe");
  }
  chmodSync(path, mode);
}

function atomicWrite(path, content, mode = 0o600) {
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporaryPath, content, { flag: "wx", mode });
  renameSync(temporaryPath, path);
  chmodSync(path, mode);
}

function atomicSymlink(target, path) {
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  symlinkSync(target, temporaryPath);
  renameSync(temporaryPath, path);
}

function readOptionalSafeLink(path) {
  if (!existsSync(path)) return null;
  const stats = lstatSync(path);
  if (!stats.isSymbolicLink() || !isOwned(stats)) throw new Error("release-link-unsafe");
  const target = readlinkSync(path);
  if (isAbsolute(target) || target.includes("\0") || target.includes("\n")) throw new Error("release-link-unsafe");
  return target;
}

function restoreLink(path, target) {
  if (target === null) {
    if (existsSync(path) || lstatExists(path)) rmSync(path);
    return;
  }
  atomicSymlink(target, path);
}

function lstatExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function validateReleaseId(releaseId) {
  if (typeof releaseId !== "string" || !RELEASE_ID_PATTERN.test(releaseId) || releaseId === "." || releaseId === "..") {
    throw new Error("release-id-invalid");
  }
  return releaseId;
}

function validateManifestPath(releaseRoot, relativePath) {
  if (typeof relativePath !== "string"
    || !relativePath
    || isAbsolute(relativePath)
    || relativePath.includes("\0")
    || relativePath.includes("\n")
    || relativePath.split(/[\\/]/).some((part) => part === ".." || part === "")) {
    throw new Error("manifest-path-invalid");
  }
  const root = realpathSync(releaseRoot);
  const absolutePath = resolve(root, relativePath);
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (!absolutePath.startsWith(rootPrefix)) throw new Error("manifest-path-invalid");
  const stats = lstatSync(absolutePath);
  if (!stats.isFile() || stats.isSymbolicLink() || !isOwned(stats)) throw new Error("manifest-file-unsafe");
  const canonicalPath = realpathSync(absolutePath);
  if (!canonicalPath.startsWith(rootPrefix)) throw new Error("manifest-file-unsafe");
  return { absolutePath, relativePath: relative(root, canonicalPath).split(sep).join("/") };
}

export function classifyUpdateRequest(args) {
  if (!Array.isArray(args) || args[0] !== "update") return { kind: "execute" };
  const updateArgs = args.slice(1);
  const allowedFlags = new Set([
    "-a",
    "-na",
    "--all",
    "--approve",
    "--extension",
    "--extensions",
    "--force",
    "--models",
    "--no-approve",
    "--self",
  ]);
  if (updateArgs.some((argument) => argument.startsWith("-") && !allowedFlags.has(argument))) {
    return { kind: "refuse" };
  }
  const positionalTargets = updateArgs.filter((argument) => !argument.startsWith("-"));
  const hasExplicitSelf = updateArgs.includes("--self")
    || updateArgs.includes("--all")
    || positionalTargets.includes("pi")
    || positionalTargets.includes("self");
  const hasExplicitDelegate = updateArgs.includes("--models")
    || updateArgs.includes("--extensions")
    || updateArgs.includes("--extension")
    || positionalTargets.some((target) => target !== "pi" && target !== "self");
  if (hasExplicitSelf && hasExplicitDelegate) return { kind: "refuse" };
  if (hasExplicitDelegate) return { kind: "delegate" };
  return {
    kind: "self",
    force: updateArgs.includes("--force"),
    updateExtensions: updateArgs.includes("--all"),
  };
}

export function parseLatestRelease(payload, integrity) {
  if (!payload || payload.ok !== true || payload.packageName !== PI_PACKAGE_NAME) {
    throw new Error("release-package-refused");
  }
  if (typeof payload.version !== "string" || !EXACT_VERSION_PATTERN.test(payload.version)) {
    throw new Error("release-version-invalid");
  }
  if (typeof integrity !== "string" || !INTEGRITY_PATTERN.test(integrity)) {
    throw new Error("release-integrity-invalid");
  }
  return { packageName: PI_PACKAGE_NAME, version: payload.version, integrity };
}

export function compareVersions(left, right) {
  if (!EXACT_VERSION_PATTERN.test(left) || !EXACT_VERSION_PATTERN.test(right)) throw new Error("release-version-invalid");
  const leftSeparator = left.indexOf("-");
  const rightSeparator = right.indexOf("-");
  const leftCore = leftSeparator < 0 ? left : left.slice(0, leftSeparator);
  const rightCore = rightSeparator < 0 ? right : right.slice(0, rightSeparator);
  const leftPreRelease = leftSeparator < 0 ? undefined : left.slice(leftSeparator + 1);
  const rightPreRelease = rightSeparator < 0 ? undefined : right.slice(rightSeparator + 1);
  const leftParts = leftCore.split(".").map(Number);
  const rightParts = rightCore.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] > rightParts[index] ? 1 : -1;
  }
  if (leftPreRelease === rightPreRelease) return 0;
  if (leftPreRelease === undefined) return 1;
  if (rightPreRelease === undefined) return -1;
  const leftIdentifiers = leftPreRelease.split(".");
  const rightIdentifiers = rightPreRelease.split(".");
  const identifierCount = Math.max(leftIdentifiers.length, rightIdentifiers.length);
  for (let index = 0; index < identifierCount; index += 1) {
    const leftIdentifier = leftIdentifiers[index];
    const rightIdentifier = rightIdentifiers[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) return BigInt(leftIdentifier) > BigInt(rightIdentifier) ? 1 : -1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftIdentifier > rightIdentifier ? 1 : -1;
  }
  return 0;
}

export function releaseIdFor(release) {
  if (!release || typeof release.version !== "string" || !EXACT_VERSION_PATTERN.test(release.version)) {
    throw new Error("release-version-invalid");
  }
  if (typeof release.integrity !== "string" || !INTEGRITY_PATTERN.test(release.integrity)) {
    throw new Error("release-integrity-invalid");
  }
  const integrityHash = createHash("sha256").update(release.integrity).digest("hex").slice(0, 12);
  return `${release.version}-${integrityHash}`;
}

function lockMode(stats) {
  return stats.mode & 0o777;
}

function readUpdateLockOwner(lockPath) {
  const ownerPath = join(lockPath, "owner.json");
  let ownerStats;
  let owner;
  try {
    ownerStats = lstatSync(ownerPath);
    if (!ownerStats.isFile()
      || ownerStats.isSymbolicLink()
      || !isOwned(ownerStats)
      || lockMode(ownerStats) !== 0o600
      || ownerStats.size > 4096) {
      throw new Error("update-lock-owner-invalid");
    }
    owner = JSON.parse(readFileSync(ownerPath, "utf8"));
  } catch (error) {
    if (error?.message === "update-lock-owner-invalid") throw error;
    throw new Error("update-lock-owner-invalid");
  }

  const keys = owner && typeof owner === "object" && !Array.isArray(owner)
    ? Object.keys(owner).sort()
    : [];
  const acquiredAt = typeof owner?.acquiredAt === "string" ? new Date(owner.acquiredAt) : null;
  if (keys.length !== UPDATE_LOCK_OWNER_KEYS.length
    || keys.some((key, index) => key !== UPDATE_LOCK_OWNER_KEYS[index])
    || owner.version !== 1
    || !Number.isSafeInteger(owner.pid)
    || owner.pid <= 0
    || typeof owner.nonce !== "string"
    || !UUID_PATTERN.test(owner.nonce)
    || acquiredAt === null
    || Number.isNaN(acquiredAt.valueOf())
    || acquiredAt.toISOString() !== owner.acquiredAt) {
    throw new Error("update-lock-owner-invalid");
  }
  return owner;
}

function inspectUpdateLock(lockPath) {
  let stats;
  try {
    stats = lstatSync(lockPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!stats.isDirectory()
    || stats.isSymbolicLink()
    || !isOwned(stats)
    || lockMode(stats) !== 0o700) {
    throw new Error("update-lock-unsafe");
  }
  return { owner: readUpdateLockOwner(lockPath), stats };
}

export function lockOwnerAlive(pid, killProcess = process.kill) {
  try {
    killProcess(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw new Error("update-lock-owner-invalid");
  }
}

function sameLock(lockPath, expected) {
  const inspected = inspectUpdateLock(lockPath);
  return inspected !== null
    && inspected.stats.dev === expected.stats.dev
    && inspected.stats.ino === expected.stats.ino
    && inspected.owner.nonce === expected.owner.nonce;
}

function quarantineVerifiedLock(lockPath, expected, label) {
  const quarantinePath = join(dirname(lockPath), `.${label}-${randomUUID()}`);
  renameSync(lockPath, quarantinePath);
  let matches = false;
  try {
    matches = sameLock(quarantinePath, expected);
  } catch {
    matches = false;
  }
  if (!matches) {
    // The rename closes the check/delete race; a mismatch is restored when no
    // competing owner has already claimed the canonical lock path.
    if (!lstatExists(lockPath)) renameSync(quarantinePath, lockPath);
    throw new Error("update-lock-replaced");
  }
  return quarantinePath;
}

export function acquireUpdateLock(deploymentRoot) {
  ensureOwnedDirectory(deploymentRoot);
  const lockPath = join(deploymentRoot, "update.lock");
  for (let attempt = 0; attempt < UPDATE_LOCK_RETRIES; attempt += 1) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      chmodSync(lockPath, 0o700);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = inspectUpdateLock(lockPath);
      if (existing === null) continue;
      if (lockOwnerAlive(existing.owner.pid)) throw new Error("update-lock-active");
      let quarantinePath;
      try {
        quarantinePath = quarantineVerifiedLock(lockPath, existing, "update-lock-dead");
      } catch (reclaimError) {
        if (reclaimError?.code === "ENOENT") continue;
        throw reclaimError;
      }
      rmSync(quarantinePath, { recursive: true });
      continue;
    }

    const owner = {
      version: 1,
      pid: process.pid,
      nonce: randomUUID(),
      acquiredAt: new Date().toISOString(),
    };
    atomicWrite(join(lockPath, "owner.json"), `${JSON.stringify(owner)}\n`);
    const acquired = inspectUpdateLock(lockPath);
    if (acquired === null || acquired.owner.nonce !== owner.nonce) throw new Error("update-lock-replaced");
    let released = false;
    return () => {
      if (released) return;
      if (!sameLock(lockPath, acquired)) throw new Error("update-lock-replaced");
      const quarantinePath = quarantineVerifiedLock(lockPath, acquired, "update-lock-release");
      rmSync(quarantinePath, { recursive: true });
      released = true;
    };
  }
  throw new Error("update-lock-retry-exhausted");
}

export function buildCriticalManifest(releaseRoot, relativePaths, manifestPath) {
  if (!Array.isArray(relativePaths) || relativePaths.length === 0) throw new Error("manifest-paths-required");
  const entries = relativePaths.map((path) => validateManifestPath(releaseRoot, path));
  const uniquePaths = new Set(entries.map((entry) => entry.relativePath));
  if (uniquePaths.size !== entries.length) throw new Error("manifest-path-duplicate");
  const content = entries
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
    .map(({ absolutePath, relativePath }) => `${createHash("sha256").update(readFileSync(absolutePath)).digest("hex")}  ${relativePath}`)
    .join("\n");
  atomicWrite(manifestPath, `${content}\n`);
  return entries.length;
}

export function verifyCriticalManifest(releaseRoot, manifestPath) {
  try {
    const manifestStats = lstatSync(manifestPath);
    if (!manifestStats.isFile() || manifestStats.isSymbolicLink() || !isOwned(manifestStats)) return false;
    const lines = readFileSync(manifestPath, "utf8").split("\n").filter(Boolean);
    if (lines.length === 0) return false;
    const seen = new Set();
    for (const line of lines) {
      const match = MANIFEST_LINE_PATTERN.exec(line);
      if (!match || seen.has(match[2])) return false;
      seen.add(match[2]);
      const entry = validateManifestPath(releaseRoot, match[2]);
      const actualHash = createHash("sha256").update(readFileSync(entry.absolutePath)).digest("hex");
      if (actualHash !== match[1]) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function promoteCandidate({
  deploymentRoot,
  candidatePath,
  releaseId,
  qualificationGates,
  postActivationGate,
}) {
  validateReleaseId(releaseId);
  ensureOwnedDirectory(join(deploymentRoot, "releases"));
  ensureOwnedDirectory(join(deploymentRoot, "candidates"));
  const candidateStats = lstatSync(candidatePath);
  if (!candidateStats.isDirectory() || candidateStats.isSymbolicLink() || !isOwned(candidateStats)) {
    throw new Error("candidate-directory-unsafe");
  }
  const candidateParent = realpathSync(dirname(candidatePath));
  if (candidateParent !== realpathSync(join(deploymentRoot, "candidates"))) throw new Error("candidate-path-invalid");
  const currentPath = join(deploymentRoot, "current");
  const previousPath = join(deploymentRoot, "previous");
  const originalCurrent = readOptionalSafeLink(currentPath);
  const originalPrevious = readOptionalSafeLink(previousPath);
  if (!originalCurrent?.startsWith("releases/")) throw new Error("current-release-required");

  const passedGates = [];
  for (const gate of qualificationGates ?? []) {
    if (!gate || typeof gate.name !== "string" || !RELEASE_ID_PATTERN.test(gate.name) || typeof gate.run !== "function") {
      throw new Error("qualification-gate-invalid");
    }
    let passed = false;
    try {
      passed = await gate.run(candidatePath) === true;
    } catch {
      passed = false;
    }
    if (!passed) throw new Error(`qualification-gate-refused:${gate.name}`);
    passedGates.push(gate.name);
  }

  const finalPath = join(deploymentRoot, "releases", releaseId);
  if (lstatExists(finalPath)) throw new Error("release-already-exists");
  renameSync(candidatePath, finalPath);
  atomicSymlink(originalCurrent, previousPath);
  atomicSymlink(`releases/${releaseId}`, currentPath);

  let postActivationPassed = false;
  try {
    postActivationPassed = await postActivationGate(finalPath) === true;
  } catch {
    postActivationPassed = false;
  }
  if (!postActivationPassed) {
    restoreLink(currentPath, originalCurrent);
    restoreLink(previousPath, originalPrevious);
    renameSync(finalPath, candidatePath);
    throw new Error("post-activation-gate-refused");
  }

  return { activated: true, releaseId, gates: passedGates };
}

export function rollbackRelease(deploymentRoot) {
  const currentPath = join(deploymentRoot, "current");
  const previousPath = join(deploymentRoot, "previous");
  const current = readOptionalSafeLink(currentPath);
  const previous = readOptionalSafeLink(previousPath);
  if (!current?.startsWith("releases/") || !previous?.startsWith("releases/")) {
    throw new Error("rollback-release-unavailable");
  }
  const previousRelease = join(deploymentRoot, previous);
  const stats = statSync(previousRelease);
  if (!stats.isDirectory() || !isOwned(stats)) throw new Error("rollback-release-unsafe");
  atomicSymlink(previous, currentPath);
  atomicSymlink(current, previousPath);
  return { rolledBack: true, current: previous.slice("releases/".length), previous: current.slice("releases/".length) };
}
