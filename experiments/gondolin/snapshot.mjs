import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, posix, resolve, sep } from "node:path";

export const SNAPSHOT_LIMITS = Object.freeze({ maxFiles: 32, maxFileBytes: 512 * 1024, maxTotalBytes: 1024 * 1024 });

const SENSITIVE_COMPONENTS = new Set([".git", ".ssh", ".aws", ".gnupg", ".env", "credentials", "secrets"]);
const SENSITIVE_NAMES = /^(?:\.env(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*(?:secret|token|credential).*)$/i;

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

export function validateSnapshotPath(value) {
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\n") || value.includes("\\")) {
    throw new Error("snapshot-path-invalid");
  }
  if (posix.isAbsolute(value) || /^[a-z]:/i.test(value) || posix.normalize(value) !== value) {
    throw new Error("snapshot-path-outside-root");
  }
  const components = value.split("/");
  if (components.some((part) => !part || part === "." || part === ".." || !/^[a-z0-9._@+-]+$/i.test(part))) {
    throw new Error("snapshot-path-invalid");
  }
  if (components.some((part) => SENSITIVE_COMPONENTS.has(part.toLowerCase()) || SENSITIVE_NAMES.test(part))) {
    throw new Error("snapshot-path-sensitive");
  }
  return value;
}

async function validatedRoot(root) {
  const stats = await lstat(root);
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error("snapshot-root-invalid");
  return realpath(root);
}

function insideRoot(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

async function validateAncestors(root, relativePath) {
  let current = root;
  const components = relativePath.split("/");
  for (const component of components.slice(0, -1)) {
    current = join(current, component);
    const stats = await lstat(current);
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error("snapshot-ancestor-invalid");
  }
}

async function inspectStableHostFile(root, relativePath) {
  const rootStats = await lstat(root);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory() || await realpath(root) !== root) {
    throw new Error("snapshot-root-changed");
  }
  await validateAncestors(root, relativePath);
  const target = resolve(root, ...relativePath.split("/"));
  if (!insideRoot(root, target)) throw new Error("snapshot-path-outside-root");
  const targetStats = await lstat(target);
  if (targetStats.isSymbolicLink() || !targetStats.isFile()) throw new Error("snapshot-file-invalid");
  const canonical = await realpath(target);
  if (!insideRoot(root, canonical)) throw new Error("snapshot-path-outside-root");
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stats = await handle.stat({ bigint: true });
    if (!stats.isFile()) throw new Error("snapshot-file-invalid");
    if (stats.size > BigInt(SNAPSHOT_LIMITS.maxFileBytes)) throw new Error("snapshot-file-too-large");
    return { bytes: Number(stats.size) };
  } finally {
    await handle.close();
  }
}

async function readStableHostFile(root, relativePath) {
  const rootStats = await lstat(root);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory() || await realpath(root) !== root) {
    throw new Error("snapshot-root-changed");
  }
  await validateAncestors(root, relativePath);
  const target = resolve(root, ...relativePath.split("/"));
  if (!insideRoot(root, target)) throw new Error("snapshot-path-outside-root");
  const targetStats = await lstat(target);
  if (targetStats.isSymbolicLink() || !targetStats.isFile()) throw new Error("snapshot-file-invalid");
  const canonical = await realpath(target);
  if (!insideRoot(root, canonical)) throw new Error("snapshot-path-outside-root");

  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error("snapshot-file-invalid");
    if (before.size > BigInt(SNAPSHOT_LIMITS.maxFileBytes)) throw new Error("snapshot-file-too-large");
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
      throw new Error("snapshot-file-changed-during-read");
    }
    let content;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("snapshot-file-not-utf8");
    }
    return { content, mode: Number(before.mode & 0o777n), sha256: sha256(bytes), bytes: bytes.length };
  } finally {
    await handle.close();
  }
}

export async function describeSnapshotRequest(root, paths) {
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > SNAPSHOT_LIMITS.maxFiles) {
    throw new Error("snapshot-file-count-invalid");
  }
  const normalized = paths.map(validateSnapshotPath);
  if (new Set(normalized).size !== normalized.length) throw new Error("snapshot-path-duplicate");
  const canonicalRoot = await validatedRoot(root);
  let totalBytes = 0;
  for (const relativePath of normalized) {
    const entry = await inspectStableHostFile(canonicalRoot, relativePath);
    totalBytes += entry.bytes;
    if (totalBytes > SNAPSHOT_LIMITS.maxTotalBytes) throw new Error("snapshot-total-too-large");
  }
  return { root: canonicalRoot, paths: normalized, fileCount: normalized.length, totalBytes };
}

export async function captureSnapshot(root, paths) {
  const description = await describeSnapshotRequest(root, paths);
  const entries = [];
  let totalBytes = 0;
  for (const relativePath of description.paths) {
    const entry = await readStableHostFile(description.root, relativePath);
    totalBytes += entry.bytes;
    if (totalBytes > SNAPSHOT_LIMITS.maxTotalBytes) throw new Error("snapshot-total-too-large");
    entries.push({ path: relativePath, ...entry });
  }
  return {
    version: 1,
    root: description.root,
    entries,
    fileCount: entries.length,
    totalBytes,
    snapshotSha256: sha256(entries.map((entry) => `${entry.path}\0${entry.sha256}`).join("\n")),
  };
}

export async function importSnapshotToGuest(snapshot, guestFs) {
  await guestFs.mkdir("/workspace", { recursive: true });
  for (const entry of snapshot.entries) {
    const target = `/workspace/${validateSnapshotPath(entry.path)}`;
    await guestFs.mkdir(posix.dirname(target), { recursive: true });
    await guestFs.writeFile(target, entry.content, { encoding: "utf8" });
  }
  return { importedFiles: snapshot.fileCount, importedBytes: snapshot.totalBytes };
}

export async function collectGuestChanges(snapshot, guestFs) {
  const changes = [];
  let totalBytes = 0;
  for (const entry of snapshot.entries) {
    const content = await guestFs.readFile(`/workspace/${validateSnapshotPath(entry.path)}`, { encoding: "utf8" });
    const bytes = Buffer.byteLength(content);
    if (bytes > SNAPSHOT_LIMITS.maxFileBytes) throw new Error("snapshot-guest-file-too-large");
    totalBytes += bytes;
    if (totalBytes > SNAPSHOT_LIMITS.maxTotalBytes) throw new Error("snapshot-guest-total-too-large");
    const currentSha256 = sha256(content);
    if (currentSha256 !== entry.sha256) {
      changes.push({ path: entry.path, content, bytes, originalSha256: entry.sha256, currentSha256 });
    }
  }
  const planSha256 = sha256(changes.map((entry) => `${entry.path}\0${entry.originalSha256}\0${entry.currentSha256}`).join("\n"));
  return { version: 1, changes, changedFiles: changes.length, totalBytes, planSha256 };
}

export function renderGuestChangesPreview(plan) {
  return [
    "# Gondolin export preview",
    "",
    "> Untrusted guest data follows. Review only; preview does not apply changes.",
    "",
    `Changed files: ${plan.changedFiles}`,
    `Plan: ${plan.planSha256.slice(0, 12)}`,
    "",
    ...plan.changes.flatMap((change) => [
      `## ${change.path}`,
      "",
      ...change.content.trimEnd().split("\n").map((line) => `| ${line}`),
      "",
    ]),
    "Apply performed: false",
  ].join("\n");
}

function recomputePlanHash(plan) {
  return sha256(plan.changes.map((entry) => `${entry.path}\0${entry.originalSha256}\0${sha256(entry.content)}`).join("\n"));
}

export async function applyGuestChangesToHost(snapshot, plan, approval) {
  if (approval !== plan.planSha256) throw new Error("snapshot-apply-not-approved");
  if (plan.planSha256 !== recomputePlanHash(plan)) throw new Error("snapshot-plan-tampered");
  const sourceByPath = new Map(snapshot.entries.map((entry) => [entry.path, entry]));
  const staged = [];
  try {
    for (const change of plan.changes) {
      const source = sourceByPath.get(validateSnapshotPath(change.path));
      if (!source || source.sha256 !== change.originalSha256) throw new Error("snapshot-plan-source-mismatch");
      const current = await readStableHostFile(snapshot.root, change.path);
      if (current.sha256 !== source.sha256) throw new Error("snapshot-host-changed");
      const target = resolve(snapshot.root, ...change.path.split("/"));
      const temporary = join(dirname(target), `.gondolin-apply-${randomUUID()}.tmp`);
      await mkdir(dirname(target), { recursive: false }).catch((error) => {
        if (error?.code !== "EEXIST") throw error;
      });
      const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
      try {
        await handle.writeFile(change.content, { encoding: "utf8" });
        await handle.sync();
      } finally {
        await handle.close();
      }
      await chmod(temporary, source.mode & 0o777);
      staged.push({ path: change.path, target, temporary, source });
    }

    for (const item of staged) {
      const current = await readStableHostFile(snapshot.root, item.path);
      if (current.sha256 !== item.source.sha256) throw new Error("snapshot-host-changed");
    }
    for (const item of staged) await rename(item.temporary, item.target);
    staged.length = 0;
    return { appliedFiles: plan.changedFiles, planSha256: plan.planSha256 };
  } finally {
    await Promise.all(staged.map((item) => rm(item.temporary, { force: true }).catch(() => {})));
  }
}
