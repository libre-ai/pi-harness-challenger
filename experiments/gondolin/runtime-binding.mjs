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
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";

const HOMEBREW_NODE_PATTERN = /^(\/opt\/homebrew|\/usr\/local)\/Cellar\/node\/([0-9A-Za-z][0-9A-Za-z._+-]*)\/bin\/node$/;
const RECOVERY_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const NODE_VERSION_PATTERN = /^v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/;
const BINDING_ID_PATTERN = /^node-[0-9A-Za-z.+-]+-[a-f0-9]{12}$/;
const BINDING_SOURCES = new Set(["homebrew", "homebrew-recovery", "install", "v3-adoption"]);

export const RUNTIME_BINDING_VERSION = 1;

function requireSafeAbsolutePath(path) {
  if (typeof path !== "string"
    || !isAbsolute(path)
    || path.includes("\0")
    || path.includes("\n")
    || path.includes("\r")) {
    throw new Error("node-runtime-path-invalid");
  }
  return path;
}

export function homebrewRecoveryAnchor(canonicalNodePath) {
  if (typeof canonicalNodePath !== "string"
    || canonicalNodePath.includes("\0")
    || canonicalNodePath.includes("\n")
    || canonicalNodePath.includes("\r")) {
    throw new Error("node-runtime-layout-unsupported");
  }
  const match = HOMEBREW_NODE_PATTERN.exec(canonicalNodePath);
  if (!match) throw new Error("node-runtime-layout-unsupported");
  return `${match[1]}/opt/node/bin/node`;
}

export function buildRecoveryEnvironment({ deploymentRoot, home }) {
  requireSafeAbsolutePath(deploymentRoot);
  requireSafeAbsolutePath(home);
  return {
    HOME: home,
    PATH: RECOVERY_PATH,
    PI_GONDOLIN_DEPLOYMENT_ROOT: deploymentRoot,
    TMPDIR: join(deploymentRoot, "tmp"),
  };
}

function isOwned(stats) {
  return typeof process.getuid !== "function" || stats.uid === process.getuid();
}

function requirePrivateDirectory(path) {
  const stats = lstatSync(path);
  if (!stats.isDirectory()
    || stats.isSymbolicLink()
    || !isOwned(stats)
    || (stats.mode & 0o077) !== 0) {
    throw new Error("node-runtime-binding-directory-unsafe");
  }
}

function ensurePrivateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  requirePrivateDirectory(path);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function atomicSymlink(target, path) {
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  symlinkSync(target, temporaryPath);
  renameSync(temporaryPath, path);
}

function requireCanonicalExecutable(path) {
  requireSafeAbsolutePath(path);
  const canonicalPath = realpathSync(path);
  const stats = lstatSync(canonicalPath);
  if (canonicalPath !== path
    || !stats.isFile()
    || stats.isSymbolicLink()
    || !isOwned(stats)
    || (stats.mode & 0o111) === 0) {
    throw new Error("node-runtime-executable-unsafe");
  }
  return canonicalPath;
}

function requireNodeVersion(nodeVersion) {
  if (typeof nodeVersion !== "string" || !NODE_VERSION_PATTERN.test(nodeVersion)) {
    throw new Error("node-runtime-version-invalid");
  }
  return nodeVersion;
}

function requireQualifiedAt(qualifiedAt) {
  if (typeof qualifiedAt !== "string"
    || Number.isNaN(Date.parse(qualifiedAt))
    || new Date(qualifiedAt).toISOString() !== qualifiedAt) {
    throw new Error("node-runtime-qualified-at-invalid");
  }
  return qualifiedAt;
}

function requireBindingSource(source) {
  if (!BINDING_SOURCES.has(source)) throw new Error("node-runtime-source-invalid");
  return source;
}

function bindingIdFor(canonicalNodePath, nodeVersion, qualifiedAt) {
  const normalizedVersion = nodeVersion.slice(1);
  const digest = sha256(`${canonicalNodePath}\0${nodeVersion}\0${qualifiedAt}`).slice(0, 12);
  return `node-${normalizedVersion}-${digest}`;
}

function writeBinding(candidateRoot, metadata) {
  mkdirSync(candidateRoot, { mode: 0o700 });
  const metadataText = `${JSON.stringify(metadata, null, 2)}\n`;
  writeFileSync(join(candidateRoot, "binding.json"), metadataText, { flag: "wx", mode: 0o600 });
  symlinkSync(metadata.canonicalNodePath, join(candidateRoot, "node"));
  const manifest = `${sha256(metadataText)}  binding.json\n${sha256(metadata.canonicalNodePath)}  node.target\n`;
  writeFileSync(join(candidateRoot, "binding.sha256"), manifest, { flag: "wx", mode: 0o600 });
}

function inspectBindingRoot(bindingRoot, { active, requireExecutable }) {
  requirePrivateDirectory(bindingRoot);
  const metadataPath = join(bindingRoot, "binding.json");
  const manifestPath = join(bindingRoot, "binding.sha256");
  const nodePath = join(bindingRoot, "node");
  for (const path of [metadataPath, manifestPath]) {
    const stats = lstatSync(path);
    if (!stats.isFile()
      || stats.isSymbolicLink()
      || !isOwned(stats)
      || (stats.mode & 0o077) !== 0) {
      throw new Error("node-runtime-binding-file-unsafe");
    }
  }
  const nodeStats = lstatSync(nodePath);
  if (!nodeStats.isSymbolicLink() || !isOwned(nodeStats)) {
    throw new Error("node-runtime-binding-node-unsafe");
  }
  const metadataText = readFileSync(metadataPath, "utf8");
  const canonicalNodePath = readlinkSync(nodePath);
  const expectedManifest = `${sha256(metadataText)}  binding.json\n${sha256(canonicalNodePath)}  node.target\n`;
  if (readFileSync(manifestPath, "utf8") !== expectedManifest) {
    throw new Error("node-runtime-binding-manifest-mismatch");
  }
  const metadata = JSON.parse(metadataText);
  if (metadata.runtimeBindingVersion !== RUNTIME_BINDING_VERSION
    || metadata.canonicalNodePath !== canonicalNodePath
    || !BINDING_ID_PATTERN.test(metadata.bindingId)
    || metadata.bindingId !== bindingIdFor(
      canonicalNodePath,
      requireNodeVersion(metadata.nodeVersion),
      requireQualifiedAt(metadata.qualifiedAt),
    )
    || requireBindingSource(metadata.recoverySource) !== metadata.recoverySource) {
    throw new Error("node-runtime-binding-metadata-invalid");
  }
  if (requireExecutable) requireCanonicalExecutable(canonicalNodePath);
  return {
    bindingId: metadata.bindingId,
    bindingRoot,
    canonicalNodePath,
    nodePath,
    nodeVersion: metadata.nodeVersion,
    qualifiedAt: metadata.qualifiedAt,
    recoverySource: metadata.recoverySource,
    active,
  };
}

export function inspectRuntimeBinding({ deploymentRoot, requireExecutable = true }) {
  requireSafeAbsolutePath(deploymentRoot);
  requirePrivateDirectory(deploymentRoot);
  const currentPath = join(deploymentRoot, "node-current");
  const currentStats = lstatSync(currentPath);
  if (!currentStats.isSymbolicLink() || !isOwned(currentStats)) {
    throw new Error("node-runtime-current-unsafe");
  }
  const currentTarget = readlinkSync(currentPath);
  const match = /^node-bindings\/(node-[0-9A-Za-z.+-]+-[a-f0-9]{12})$/.exec(currentTarget);
  if (!match) throw new Error("node-runtime-current-unsafe");
  const bindingRoot = join(deploymentRoot, "node-bindings", match[1]);
  const binding = inspectBindingRoot(bindingRoot, { active: true, requireExecutable });
  if (binding.bindingId !== match[1]) throw new Error("node-runtime-current-unsafe");
  return binding;
}

export async function promoteRuntimeBinding({
  deploymentRoot,
  canonicalNodePath,
  nodeVersion,
  qualifiedAt,
  source,
  qualificationGate,
}) {
  requireSafeAbsolutePath(deploymentRoot);
  requirePrivateDirectory(deploymentRoot);
  requireCanonicalExecutable(canonicalNodePath);
  requireNodeVersion(nodeVersion);
  requireQualifiedAt(qualifiedAt);
  requireBindingSource(source);
  if (typeof qualificationGate !== "function") throw new Error("node-runtime-qualification-gate-missing");

  const bindingsRoot = join(deploymentRoot, "node-bindings");
  ensurePrivateDirectory(bindingsRoot);
  const bindingId = bindingIdFor(canonicalNodePath, nodeVersion, qualifiedAt);
  const finalBindingRoot = join(bindingsRoot, bindingId);
  if (existsSync(finalBindingRoot)) throw new Error("node-runtime-binding-exists");
  const candidateRoot = join(bindingsRoot, `.candidate-${process.pid}-${randomUUID()}`);
  let candidatePromoted = false;
  try {
    writeBinding(candidateRoot, {
      runtimeBindingVersion: RUNTIME_BINDING_VERSION,
      bindingId,
      canonicalNodePath,
      nodeVersion,
      qualifiedAt,
      recoverySource: source,
    });
    inspectBindingRoot(candidateRoot, { active: false, requireExecutable: true });
    if (!await qualificationGate(canonicalNodePath)) {
      throw new Error("node-runtime-qualification-refused");
    }
    chmodSync(join(candidateRoot, "binding.json"), 0o400);
    chmodSync(join(candidateRoot, "binding.sha256"), 0o400);
    chmodSync(candidateRoot, 0o500);
    renameSync(candidateRoot, finalBindingRoot);
    candidatePromoted = true;
    atomicSymlink(`node-bindings/${bindingId}`, join(deploymentRoot, "node-current"));
    return inspectRuntimeBinding({ deploymentRoot, requireExecutable: true });
  } finally {
    if (!candidatePromoted && existsSync(candidateRoot)) {
      rmSync(candidateRoot, { recursive: true, force: true });
    }
  }
}
