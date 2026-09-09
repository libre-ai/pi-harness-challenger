import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import {
  PI_PACKAGE_NAME,
  acquireUpdateLock,
  buildCriticalManifest,
  classifyUpdateRequest,
  compareVersions,
  parseLatestRelease,
  promoteCandidate,
  releaseIdFor,
  rollbackRelease,
  verifyCriticalManifest,
} from "./release-manager.mjs";
import {
  buildRecoveryEnvironment,
  homebrewRecoveryAnchor,
  inspectRuntimeBinding,
  promoteRuntimeBinding,
} from "./runtime-binding.mjs";
import {
  advanceRuntimeAdoption,
  beginRuntimeAdoption,
  recoverRuntimeAdoption,
} from "./runtime-adoption.mjs";

const DEPLOYMENT_VERSION = 3;
const LAUNCH_AGENT_LABEL = "dev.pi-gondolin.transactional-update";
const LATEST_RELEASE_URL = "https://pi.dev/api/latest-version";
const PACKAGE_RELATIVE_PATH = join("node_modules", "@earendil-works", "pi-coding-agent");
const GUARDED_RPC_ENTRY = "#!/usr/bin/env node\nprocess.stderr.write(\"pi-rpc-launcher-required\\n\");\nprocess.exit(64);\n";
const ACCEPTED_LICENSES = new Set([
  "0BSD",
  "Apache-2.0",
  "BlueOak-1.0.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "MIT",
  "MPL-2.0",
]);
const RUNTIME_EXPERIMENT_FILES = [
  "budget-test.mjs",
  "deployed-rpc-e2e.mjs",
  "extension.mjs",
  "license-exception.json",
  "package-lock.json",
  "package.json",
  "rpc-gate.mjs",
  "safe-rpc-launcher.mjs",
  "sandbox.mjs",
  "snapshot.mjs",
];

function isOwned(stats) {
  return typeof process.getuid !== "function" || stats.uid === process.getuid();
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function ensureOwnedDirectory(path, mode = 0o700) {
  mkdirSync(path, { recursive: true, mode });
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink() || !isOwned(stats)) throw new Error("deployment-directory-unsafe");
  chmodSync(path, mode);
}

function ensureOwnedDirectoryPreservingMode(path, createMode = 0o700) {
  mkdirSync(path, { recursive: true, mode: createMode });
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink() || !isOwned(stats)) throw new Error("deployment-directory-unsafe");
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

function readOwnedJson(path) {
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink() || !isOwned(stats) || (stats.mode & 0o077) !== 0) {
    throw new Error("deployment-state-unsafe");
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeOwnedJson(path, value) {
  atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

function symlinkResolvesTo(path, expected) {
  try {
    return lstatSync(path).isSymbolicLink() && realpathSync(path) === realpathSync(expected);
  } catch {
    return false;
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
    maxBuffer: 8 * 1024 * 1024,
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    timeout: options.timeout ?? 30_000,
  });
  return result;
}

function runCommand(commandParts, args, options = {}) {
  const [command, ...prefixArgs] = commandParts;
  if (!command) throw new Error("package-command-missing");
  return run(command, [...prefixArgs, ...args], options);
}

function resultPassed(result) {
  return result.status === 0 && !result.error && !result.signal;
}

function commandStatus(result) {
  if (result.error?.code === "ETIMEDOUT" || result.signal) return 124;
  return result.status ?? 1;
}

function listRegularFiles(root, current = root) {
  const files = [];
  const entries = readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = join(current, entry.name);
    const stats = lstatSync(path);
    if (stats.isSymbolicLink() || !isOwned(stats)) throw new Error("runtime-file-unsafe");
    if (stats.isDirectory()) files.push(...listRegularFiles(root, path));
    else if (stats.isFile()) files.push(relative(root, path).split(sep).join("/"));
    else throw new Error("runtime-file-unsafe");
  }
  return files;
}

function packageRoot(candidateRoot) {
  return join(candidateRoot, PACKAGE_RELATIVE_PATH);
}

function packagePaths(candidateRoot) {
  const root = packageRoot(candidateRoot);
  return {
    root,
    packageJson: join(root, "package.json"),
    cli: join(root, "dist", "cli.js"),
    rpcEntry: join(root, "dist", "rpc-entry.js"),
    shrinkwrap: join(root, "npm-shrinkwrap.json"),
  };
}

export function verifyCandidatePackage(candidateRoot, release) {
  const paths = packagePaths(candidateRoot);
  for (const path of [paths.packageJson, paths.cli, paths.rpcEntry, paths.shrinkwrap, join(candidateRoot, "package-lock.json")]) {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink() || !isOwned(stats)) throw new Error("candidate-package-file-unsafe");
  }
  const packageMetadata = JSON.parse(readFileSync(paths.packageJson, "utf8"));
  if (packageMetadata.name !== PI_PACKAGE_NAME
    || packageMetadata.version !== release.version
    || packageMetadata.bin?.pi !== "dist/cli.js") {
    throw new Error("candidate-package-metadata-mismatch");
  }
  const lock = JSON.parse(readFileSync(join(candidateRoot, "package-lock.json"), "utf8"));
  const matchingEntries = Object.entries(lock.packages ?? {}).filter(([path, metadata]) => {
    const normalizedPath = path.replaceAll("\\", "/");
    return (normalizedPath === "node_modules/@earendil-works/pi-coding-agent"
      || normalizedPath.endsWith("/node_modules/@earendil-works/pi-coding-agent"))
      && metadata?.version === release.version;
  });
  if (matchingEntries.length !== 1 || matchingEntries[0][1].integrity !== release.integrity) {
    throw new Error("candidate-integrity-mismatch");
  }
  return paths.root;
}

export function auditPiPackageLicenses(candidatePackageRoot) {
  const shrinkwrapPath = join(candidatePackageRoot, "npm-shrinkwrap.json");
  const stats = lstatSync(shrinkwrapPath);
  if (!stats.isFile() || stats.isSymbolicLink() || !isOwned(stats)) throw new Error("candidate-license-metadata-unsafe");
  const shrinkwrap = JSON.parse(readFileSync(shrinkwrapPath, "utf8"));
  const licenses = {};
  let packageCount = 0;
  for (const metadata of Object.values(shrinkwrap.packages ?? {})) {
    const license = metadata?.license;
    packageCount += 1;
    if (typeof license !== "string" || !ACCEPTED_LICENSES.has(license)) throw new Error("candidate-license-refused");
    licenses[license] = (licenses[license] ?? 0) + 1;
  }
  if (packageCount === 0) throw new Error("candidate-license-metadata-empty");
  return { packageCount, licenses: Object.fromEntries(Object.entries(licenses).sort()), passes: true };
}

function guardCandidateRpcEntry(candidateRoot) {
  const paths = packagePaths(candidateRoot);
  const originalPath = join(candidateRoot, "rpc-entry.original.js");
  const original = readFileSync(paths.rpcEntry);
  atomicWrite(originalPath, original);
  atomicWrite(paths.rpcEntry, GUARDED_RPC_ENTRY, 0o755);
  return { originalPath, guardedSha256: sha256(paths.rpcEntry), originalSha256: sha256(originalPath) };
}

function writeReleaseMetadata(candidateRoot, release, source, rpcEntry) {
  const metadata = {
    version: 1,
    packageName: release.packageName,
    packageVersion: release.version,
    integrity: release.integrity,
    source,
    rpcEntry,
  };
  writeOwnedJson(join(candidateRoot, "release.json"), metadata);
  const criticalPaths = [
    "release.json",
    "rpc-entry.original.js",
    join(PACKAGE_RELATIVE_PATH, "package.json"),
    join(PACKAGE_RELATIVE_PATH, "dist", "cli.js"),
    join(PACKAGE_RELATIVE_PATH, "dist", "rpc-entry.js"),
    join(PACKAGE_RELATIVE_PATH, "npm-shrinkwrap.json"),
  ].map((path) => path.split(sep).join("/"));
  if (existsSync(join(candidateRoot, "package-lock.json"))) criticalPaths.push("package-lock.json");
  buildCriticalManifest(candidateRoot, criticalPaths, join(candidateRoot, "critical.sha256"));
  return metadata;
}

function readReleaseMetadata(releaseRoot) {
  const path = join(releaseRoot, "release.json");
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink() || !isOwned(stats)) throw new Error("release-metadata-unsafe");
  return JSON.parse(readFileSync(path, "utf8"));
}

function verifyRelease(releaseRoot) {
  return verifyCriticalManifest(releaseRoot, join(releaseRoot, "critical.sha256"));
}

function currentReleaseRoot(deploymentRoot) {
  const currentPath = join(deploymentRoot, "current");
  const stats = lstatSync(currentPath);
  if (!stats.isSymbolicLink() || !isOwned(stats)) throw new Error("current-release-unsafe");
  const target = readlinkSync(currentPath);
  if (!/^releases\/[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/.test(target)) throw new Error("current-release-unsafe");
  const releaseRoot = realpathSync(currentPath);
  const releasesRoot = `${realpathSync(join(deploymentRoot, "releases"))}${sep}`;
  if (!releaseRoot.startsWith(releasesRoot)) throw new Error("current-release-unsafe");
  return releaseRoot;
}

export function renderLaunchAgentPlist({ home, deploymentRoot, piWrapperPath, qemuPath = "/opt/homebrew/bin/qemu-system-aarch64" }) {
  const executablePath = `${dirname(qemuPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(piWrapperPath)}</string>
    <string>update</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${xmlEscape(home)}</string>
    <key>PI_GONDOLIN_DEPLOYMENT_ROOT</key>
    <string>${xmlEscape(deploymentRoot)}</string>
    <key>PATH</key>
    <string>${xmlEscape(executablePath)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>3600</integer>
  <key>StandardOutPath</key>
  <string>/dev/null</string>
  <key>StandardErrorPath</key>
  <string>/dev/null</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;
}

export function renderStablePiWrapper({ deploymentRoot, nodePath, nodeRecoveryPath, launcherPath }) {
  return `#!/bin/sh
set -eu
ROOT=${shellQuote(deploymentRoot)}
NODE=${shellQuote(nodePath)}
RECOVERY_NODE=${shellQuote(nodeRecoveryPath)}
LAUNCHER=${shellQuote(launcherPath)}
refuse() { printf '%s\\n' 'pi-gondolin-deployment-integrity-refused' >&2; exit 65; }
(
  cd "$ROOT"
  /usr/bin/shasum -a 256 -c controller.sha256 >/dev/null 2>&1
) || refuse
if [ ! -x "$NODE" ]; then
  [ -n "\${HOME-}" ] && [ -x "$RECOVERY_NODE" ] || refuse
  /usr/bin/env -i \\
    HOME="$HOME" \\
    PATH='/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin' \\
    PI_GONDOLIN_DEPLOYMENT_ROOT="$ROOT" \\
    TMPDIR="$ROOT/tmp" \\
    "$RECOVERY_NODE" "$ROOT/controller/update-local.mjs" runtime-repin >/dev/null 2>&1 || refuse
  [ -x "$NODE" ] || refuse
fi
if [ "\${1-}" = "update" ]; then
  export PI_GONDOLIN_DEPLOYMENT_ROOT="$ROOT"
  exec "$NODE" "$ROOT/controller/update-local.mjs" route "$@"
fi
TARGET=$(/usr/bin/readlink "$ROOT/current") || refuse
case "$TARGET" in releases/*) ;; *) refuse ;; esac
case "$TARGET" in *..*|*\\\\*|*"\n"*) refuse ;; esac
RELEASE="$ROOT/$TARGET"
[ -d "$RELEASE" ] && [ ! -L "$RELEASE" ] || refuse
(
  cd "$RELEASE"
  /usr/bin/shasum -a 256 -c critical.sha256 >/dev/null 2>&1
) || refuse
REAL_PI="$RELEASE/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
RPC=0
EXPECT_MODE=0
for ARG in "$@"; do
  if [ "$EXPECT_MODE" -eq 1 ]; then
    [ "$ARG" = "rpc" ] && RPC=1
    EXPECT_MODE=0
    continue
  fi
  case "$ARG" in
    --mode) EXPECT_MODE=1 ;;
    --mode=rpc) RPC=1 ;;
  esac
done
if [ "$RPC" -eq 1 ]; then
  [ "\${PI_GONDOLIN_RPC_ACTIVE-}" = "1" ] || { printf '%s\\n' 'pi-rpc-launcher-required' >&2; exit 64; }
  PARENT_COMMAND=$(/bin/ps -p "$PPID" -o command= 2>/dev/null || true)
  case "$PARENT_COMMAND" in *"$LAUNCHER"*) ;; *) printf '%s\\n' 'pi-rpc-launcher-required' >&2; exit 64 ;; esac
  unset PI_GONDOLIN_RPC_ACTIVE
fi
unset PI_GONDOLIN_PI_EXECUTABLE
exec "$NODE" "$REAL_PI" "$@"
`;
}

export function renderStableLauncherWrapper({ deploymentRoot, nodePath, nodeRecoveryPath, launcherPath }) {
  return `#!/bin/sh
set -eu
ROOT=${shellQuote(deploymentRoot)}
NODE=${shellQuote(nodePath)}
RECOVERY_NODE=${shellQuote(nodeRecoveryPath)}
LAUNCHER=${shellQuote(launcherPath)}
refuse() { printf '%s\\n' 'gondolin-rpc-deployment-integrity-refused' >&2; exit 65; }
(
  cd "$ROOT"
  /usr/bin/shasum -a 256 -c controller.sha256 >/dev/null 2>&1
  /usr/bin/shasum -a 256 -c runtime.sha256 >/dev/null 2>&1
) || refuse
if [ ! -x "$NODE" ]; then
  [ -n "\${HOME-}" ] && [ -x "$RECOVERY_NODE" ] || refuse
  /usr/bin/env -i \\
    HOME="$HOME" \\
    PATH='/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin' \\
    PI_GONDOLIN_DEPLOYMENT_ROOT="$ROOT" \\
    TMPDIR="$ROOT/tmp" \\
    "$RECOVERY_NODE" "$ROOT/controller/update-local.mjs" runtime-repin >/dev/null 2>&1 || refuse
  [ -x "$NODE" ] || refuse
fi
TARGET=$(/usr/bin/readlink "$ROOT/current") || refuse
case "$TARGET" in releases/*) ;; *) refuse ;; esac
case "$TARGET" in *..*|*\\\\*|*"\n"*) refuse ;; esac
RELEASE="$ROOT/$TARGET"
(
  cd "$RELEASE"
  /usr/bin/shasum -a 256 -c critical.sha256 >/dev/null 2>&1
) || refuse
unset PI_GONDOLIN_RPC_ACTIVE
export PI_GONDOLIN_PI_EXECUTABLE="$ROOT/pi"
exec "$NODE" "$LAUNCHER"
`;
}

function candidatePiWrapper({ candidateRoot, nodePath, launcherPath }) {
  const cliPath = join(packageRoot(candidateRoot), "dist", "cli.js");
  return `#!/bin/sh
set -eu
NODE=${shellQuote(nodePath)}
REAL_PI=${shellQuote(cliPath)}
LAUNCHER=${shellQuote(launcherPath)}
[ "\${1-}" != "update" ] || { printf '%s\\n' 'candidate-self-update-refused' >&2; exit 64; }
RPC=0
EXPECT_MODE=0
for ARG in "$@"; do
  if [ "$EXPECT_MODE" -eq 1 ]; then [ "$ARG" = "rpc" ] && RPC=1; EXPECT_MODE=0; continue; fi
  case "$ARG" in --mode) EXPECT_MODE=1 ;; --mode=rpc) RPC=1 ;; esac
done
if [ "$RPC" -eq 1 ]; then
  [ "\${PI_GONDOLIN_RPC_ACTIVE-}" = "1" ] || { printf '%s\\n' 'pi-rpc-launcher-required' >&2; exit 64; }
  PARENT_COMMAND=$(/bin/ps -p "$PPID" -o command= 2>/dev/null || true)
  case "$PARENT_COMMAND" in *"$LAUNCHER"*) ;; *) printf '%s\\n' 'pi-rpc-launcher-required' >&2; exit 64 ;; esac
  unset PI_GONDOLIN_RPC_ACTIVE
fi
unset PI_GONDOLIN_PI_EXECUTABLE
exec "$NODE" "$REAL_PI" "$@"
`;
}

function candidateLauncherWrapper({ piPath, nodePath, launcherPath }) {
  return `#!/bin/sh
set -eu
unset PI_GONDOLIN_RPC_ACTIVE
export PI_GONDOLIN_PI_EXECUTABLE=${shellQuote(piPath)}
exec ${shellQuote(nodePath)} ${shellQuote(launcherPath)}
`;
}

function deploymentPaths(home, overrideRoot) {
  const legacyRoot = join(home, ".local", "share", "pi-harness-challenger", "gondolin-rpc");
  const deploymentRoot = overrideRoot ?? join(legacyRoot, "v3");
  return {
    home,
    legacyRoot,
    deploymentRoot,
    statePath: join(deploymentRoot, "deployment.json"),
    piWrapper: join(deploymentRoot, "pi"),
    launcherWrapper: join(deploymentRoot, "pi-gondolin-rpc"),
    installedPi: join(home, ".local", "bin", "pi"),
    installedLauncher: join(home, ".local", "bin", "pi-gondolin-rpc"),
    launchAgentPath: join(home, "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`),
    launcherPath: join(deploymentRoot, "controller", "runtime", "experiments", "gondolin", "safe-rpc-launcher.mjs"),
  };
}

function copyRuntime(projectRoot, stagingRoot) {
  const controllerRoot = join(stagingRoot, "controller");
  const runtimeRoot = join(controllerRoot, "runtime");
  ensureOwnedDirectory(controllerRoot);
  ensureOwnedDirectory(runtimeRoot);
  cpSync(join(projectRoot, "experiments", "gondolin", "release-manager.mjs"), join(controllerRoot, "release-manager.mjs"));
  cpSync(join(projectRoot, "experiments", "gondolin", "runtime-adoption.mjs"), join(controllerRoot, "runtime-adoption.mjs"));
  cpSync(join(projectRoot, "experiments", "gondolin", "runtime-binding.mjs"), join(controllerRoot, "runtime-binding.mjs"));
  cpSync(join(projectRoot, "experiments", "gondolin", "deployment-controller.mjs"), join(controllerRoot, "deployment-controller.mjs"));
  cpSync(join(projectRoot, "experiments", "gondolin", "update-local.mjs"), join(controllerRoot, "update-local.mjs"));

  const targetExperiment = join(runtimeRoot, "experiments", "gondolin");
  ensureOwnedDirectory(targetExperiment);
  for (const file of RUNTIME_EXPERIMENT_FILES) {
    cpSync(join(projectRoot, "experiments", "gondolin", file), join(targetExperiment, file));
  }
  cpSync(join(projectRoot, "experiments", "gondolin", "node_modules"), join(targetExperiment, "node_modules"), { recursive: true });
  rmSync(join(targetExperiment, "node_modules", ".bin"), { recursive: true, force: true });
  cpSync(join(projectRoot, "extensions", "policy-gate"), join(runtimeRoot, "extensions", "policy-gate"), { recursive: true });
  ensureOwnedDirectory(join(runtimeRoot, "extensions", "shared"));
  cpSync(join(projectRoot, "extensions", "shared", "config.mjs"), join(runtimeRoot, "extensions", "shared", "config.mjs"));
  ensureOwnedDirectory(join(runtimeRoot, "scripts", "lib"));
  cpSync(join(projectRoot, "scripts", "lib", "pi-rpc.mjs"), join(runtimeRoot, "scripts", "lib", "pi-rpc.mjs"));
  cpSync(join(projectRoot, "scripts", "sandbox-license-audit.mjs"), join(runtimeRoot, "scripts", "sandbox-license-audit.mjs"));

  const controllerFiles = [
    "controller/deployment-controller.mjs",
    "controller/release-manager.mjs",
    "controller/runtime-adoption.mjs",
    "controller/runtime-binding.mjs",
    "controller/update-local.mjs",
  ];
  buildCriticalManifest(stagingRoot, controllerFiles, join(stagingRoot, "controller.sha256"));
  const runtimeFiles = listRegularFiles(stagingRoot, runtimeRoot);
  buildCriticalManifest(stagingRoot, runtimeFiles, join(stagingRoot, "runtime.sha256"));
}

function migratedIntegrity(version, cliPath, originalRpcPath, packageJsonPath) {
  const digest = createHash("sha512")
    .update(version)
    .update(readFileSync(cliPath))
    .update(readFileSync(originalRpcPath))
    .update(readFileSync(packageJsonPath))
    .digest("base64");
  return `sha512-${digest}`;
}

function verifyLegacyDeployment(paths) {
  const state = readOwnedJson(join(paths.legacyRoot, "deployment.json"));
  if (state.version !== 2
    || !symlinkResolvesTo(paths.installedPi, join(paths.legacyRoot, "pi"))
    || !symlinkResolvesTo(paths.installedLauncher, join(paths.legacyRoot, "pi-gondolin-rpc"))
    || sha256(state.originalRpcEntry.path) !== state.originalRpcEntry.guardedSha256
    || sha256(join(paths.legacyRoot, "rpc-entry.original.js")) !== state.originalRpcEntry.backupSha256
    || sha256(state.originalPi.realPath) !== state.originalPi.sha256) {
    throw new Error("legacy-deployment-invalid");
  }
  return state;
}

function prepareMigratedRelease(paths, stagingRoot, legacyState) {
  const candidateRoot = join(stagingRoot, "candidates", `migration-${randomUUID()}`);
  ensureOwnedDirectory(dirname(candidateRoot));
  ensureOwnedDirectory(candidateRoot);
  const targetPackageRoot = packageRoot(candidateRoot);
  ensureOwnedDirectory(dirname(targetPackageRoot));
  const sourcePackageRoot = resolve(dirname(legacyState.originalPi.realPath), "..");
  cpSync(sourcePackageRoot, targetPackageRoot, { recursive: true });
  const originalRpcPath = join(paths.legacyRoot, "rpc-entry.original.js");
  cpSync(originalRpcPath, join(targetPackageRoot, "dist", "rpc-entry.js"));
  const release = {
    packageName: PI_PACKAGE_NAME,
    version: legacyState.originalPi.version,
    integrity: migratedIntegrity(
      legacyState.originalPi.version,
      join(targetPackageRoot, "dist", "cli.js"),
      originalRpcPath,
      join(targetPackageRoot, "package.json"),
    ),
  };
  auditPiPackageLicenses(targetPackageRoot);
  const rpcEntry = guardCandidateRpcEntry(candidateRoot);
  writeReleaseMetadata(candidateRoot, release, "migrated-v2", rpcEntry);
  const releaseId = releaseIdFor(release);
  const finalPath = join(stagingRoot, "releases", releaseId);
  ensureOwnedDirectory(dirname(finalPath));
  renameSync(candidateRoot, finalPath);
  atomicSymlink(`releases/${releaseId}`, join(stagingRoot, "current"));
  return { release, releaseId, releaseRoot: finalPath };
}

function resolveExecutable(name) {
  const result = run("/bin/sh", ["-lc", `command -v ${name}`], { timeout: 10_000 });
  if (!resultPassed(result)) throw new Error("required-executable-missing");
  const path = result.stdout.trim();
  if (!path.startsWith("/") || path.includes("\0") || path.includes("\n")) throw new Error("required-executable-unsafe");
  const canonicalPath = realpathSync(path);
  const stats = lstatSync(canonicalPath);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("required-executable-unsafe");
  return canonicalPath;
}

function resolveNpmCommand() {
  const npmPath = process.env.npm_execpath ? realpathSync(process.env.npm_execpath) : resolveExecutable("npm");
  return [realpathSync(process.execPath), npmPath];
}

export function buildDeploymentRuntimeState({ deploymentRoot, canonicalNodePath, npmPath }) {
  const nodePath = join(deploymentRoot, "node-current", "node");
  return {
    version: DEPLOYMENT_VERSION,
    runtimeBindingVersion: 1,
    nodePath,
    nodeRecoveryPath: homebrewRecoveryAnchor(canonicalNodePath),
    npmCommand: [nodePath, npmPath],
  };
}

function qualificationEnvironment(overrides = {}, baseEnvironment = process.env) {
  return {
    ...baseEnvironment,
    PI_OFFLINE: "1",
    ...overrides,
  };
}

function qualifyRelease({ deploymentRoot, releaseRoot, nodePath, launcherPath, environment = process.env }) {
  if (!verifyRelease(releaseRoot)) return false;
  const metadata = readReleaseMetadata(releaseRoot);
  const paths = packagePaths(releaseRoot);
  try {
    auditPiPackageLicenses(paths.root);
  } catch {
    return false;
  }
  const qualificationRoot = join(deploymentRoot, "qualification", randomUUID());
  try {
    const binRoot = join(qualificationRoot, "bin");
    ensureOwnedDirectory(binRoot);
    const piPath = join(binRoot, "pi");
    const candidateLauncherPath = join(binRoot, "pi-gondolin-rpc");
    atomicWrite(piPath, candidatePiWrapper({ candidateRoot: releaseRoot, nodePath, launcherPath }), 0o700);
    atomicWrite(candidateLauncherPath, candidateLauncherWrapper({ piPath, nodePath, launcherPath }), 0o700);
    const runtimeRoot = join(deploymentRoot, "controller", "runtime");
    const candidateEnvironment = qualificationEnvironment({}, environment);
    const executionOptions = { cwd: qualificationRoot, env: candidateEnvironment };
    const directRpc = run(piPath, ["--mode", "rpc"], { ...executionOptions, timeout: 10_000 });
    const forgedRpc = run(piPath, ["--mode=rpc"], {
      ...executionOptions,
      env: { ...candidateEnvironment, PI_GONDOLIN_RPC_ACTIVE: "1" },
      timeout: 10_000,
    });
    const rpcEntry = run(nodePath, [paths.rpcEntry], { ...executionOptions, timeout: 10_000 });
    const version = run(nodePath, [paths.cli, "--version"], { ...executionOptions, timeout: 10_000 });
    const models = run(nodePath, [
      paths.cli,
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--list-models",
      "__transactional_candidate_smoke__",
    ], { ...executionOptions, timeout: 30_000 });
    const licenses = run(nodePath, [join(runtimeRoot, "scripts", "sandbox-license-audit.mjs")], {
      ...executionOptions,
      env: qualificationEnvironment({ PI_CANDIDATE_PACKAGE_ROOT: paths.root }, environment),
      timeout: 30_000,
    });
    const e2e = run(nodePath, [join(runtimeRoot, "experiments", "gondolin", "deployed-rpc-e2e.mjs")], {
      ...executionOptions,
      env: qualificationEnvironment({
        PI_GONDOLIN_DEPLOYMENT_ROOT: deploymentRoot,
        PI_GONDOLIN_LAUNCHER: candidateLauncherPath,
        PI_GONDOLIN_PI: piPath,
        PI_GONDOLIN_RPC_ENTRY: paths.rpcEntry,
      }, environment),
      timeout: 240_000,
    });
    const budgets = run(nodePath, [join(runtimeRoot, "experiments", "gondolin", "budget-test.mjs")], {
      ...executionOptions,
      env: qualificationEnvironment({ PI_GONDOLIN_LAUNCHER: candidateLauncherPath }, environment),
      timeout: 60_000,
    });
    let sandboxLicensesPassed = false;
    try {
      sandboxLicensesPassed = resultPassed(licenses) && JSON.parse(licenses.stdout).allPass === true;
    } catch {
      sandboxLicensesPassed = false;
    }
    return directRpc.status === 64
      && directRpc.stdout === ""
      && directRpc.stderr === "pi-rpc-launcher-required\n"
      && forgedRpc.status === 64
      && forgedRpc.stdout === ""
      && forgedRpc.stderr === "pi-rpc-launcher-required\n"
      && rpcEntry.status === 64
      && rpcEntry.stdout === ""
      && rpcEntry.stderr === "pi-rpc-launcher-required\n"
      && resultPassed(version)
      && version.stdout.trim() === metadata.packageVersion
      && resultPassed(models)
      && sandboxLicensesPassed
      && resultPassed(e2e)
      && resultPassed(budgets);
  } catch {
    return false;
  } finally {
    rmSync(qualificationRoot, { recursive: true, force: true });
  }
}

function writeDeploymentWrappers(stagingRoot, finalRoot, nodePath, nodeRecoveryPath) {
  const launcherPath = join(finalRoot, "controller", "runtime", "experiments", "gondolin", "safe-rpc-launcher.mjs");
  atomicWrite(
    join(stagingRoot, "pi"),
    renderStablePiWrapper({ deploymentRoot: finalRoot, nodePath, nodeRecoveryPath, launcherPath }),
    0o700,
  );
  atomicWrite(
    join(stagingRoot, "pi-gondolin-rpc"),
    renderStableLauncherWrapper({ deploymentRoot: finalRoot, nodePath, nodeRecoveryPath, launcherPath }),
    0o700,
  );
}

function postActivationSmoke(paths, expectedVersion, environment = process.env) {
  const smokeEnvironment = qualificationEnvironment({}, environment);
  const version = run(paths.piWrapper, ["--version"], { env: smokeEnvironment, timeout: 10_000 });
  const direct = run(paths.piWrapper, ["--mode", "rpc"], { env: smokeEnvironment, timeout: 10_000 });
  const incomplete = run(paths.launcherWrapper, [], {
    env: Object.fromEntries(Object.entries(smokeEnvironment).filter(([key]) => !key.startsWith("PI_GONDOLIN_"))),
    timeout: 10_000,
  });
  return resultPassed(version)
    && version.stdout.trim() === expectedVersion
    && direct.status === 64
    && direct.stderr === "pi-rpc-launcher-required\n"
    && incomplete.status === 64
    && incomplete.stderr === "gondolin-rpc-launcher-refused\n";
}

function removeDeploymentTree(path) {
  if (!existsSync(path)) return;
  function makeOwnedDirectoriesWritable(current) {
    const stats = lstatSync(current);
    if (!isOwned(stats)) throw new Error("deployment-cleanup-path-unsafe");
    if (stats.isSymbolicLink()) return;
    if (stats.isDirectory()) {
      chmodSync(current, 0o700);
      for (const entry of readdirSync(current)) {
        makeOwnedDirectoriesWritable(join(current, entry));
      }
    }
  }
  makeOwnedDirectoriesWritable(path);
  rmSync(path, { recursive: true, force: true });
}

function treeDigest(root, current = root) {
  const hash = createHash("sha256");
  for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(current, entry.name);
    hash.update(relative(root, path).split(sep).join("/"));
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) hash.update(`link:${readlinkSync(path)}`);
    else if (stats.isDirectory()) hash.update(treeDigest(root, path));
    else if (stats.isFile()) hash.update(readFileSync(path));
    else throw new Error("adoption-artifact-unsafe");
  }
  return hash.digest("hex");
}

function controllerArtifactDigest(deploymentRoot) {
  return createHash("sha256")
    .update(treeDigest(join(deploymentRoot, "controller")))
    .update(readFileSync(join(deploymentRoot, "controller.sha256")))
    .digest("hex");
}

function launchdDigest(path) {
  return existsSync(path) ? sha256(path) : "";
}

function adoptionArtifactDigests(paths) {
  return {
    controller: controllerArtifactDigest(paths.deploymentRoot),
    pi: sha256(paths.piWrapper),
    "pi-gondolin-rpc": sha256(paths.launcherWrapper),
    "deployment.json": sha256(paths.statePath),
    launchd: launchdDigest(paths.launchAgentPath),
  };
}

function adoptionArtifacts(oldDigests, newDigests) {
  return Object.fromEntries(Object.keys(oldDigests).map((key) => [key, {
    oldSha256: oldDigests[key],
    newSha256: newDigests[key],
  }]));
}

function adoptionControllerFiles() {
  return [
    "controller/deployment-controller.mjs",
    "controller/release-manager.mjs",
    "controller/runtime-adoption.mjs",
    "controller/runtime-binding.mjs",
    "controller/update-local.mjs",
  ];
}

function stageAdoptionController({ projectRoot, deploymentRoot, stagingRoot }) {
  cpSync(join(deploymentRoot, "controller"), join(stagingRoot, "controller"), { recursive: true });
  for (const file of [
    "deployment-controller.mjs",
    "release-manager.mjs",
    "runtime-adoption.mjs",
    "runtime-binding.mjs",
    "update-local.mjs",
  ]) {
    cpSync(join(projectRoot, "experiments", "gondolin", file), join(stagingRoot, "controller", file));
  }
  buildCriticalManifest(stagingRoot, adoptionControllerFiles(), join(stagingRoot, "controller.sha256"));
}

function maybeInterrupt(interruptionPoint, phase) {
  if (interruptionPoint === phase) throw new Error("adoption-test-interruption");
}

function replaceAdoptionArtifact(livePath, stagedPath, backupPath) {
  if (existsSync(livePath)) renameSync(livePath, backupPath);
  renameSync(stagedPath, livePath);
}

function stagedBindingId(stagedBindingRoot) {
  const metadata = readOwnedJson(join(stagedBindingRoot, "binding.json"));
  if (typeof metadata.bindingId !== "string" || !/^node-[0-9A-Za-z.+-]+-[a-f0-9]{12}$/.test(metadata.bindingId)) {
    throw new Error("adoption-binding-metadata-invalid");
  }
  return metadata.bindingId;
}

function activateAdoptionBinding(paths) {
  const stagedBindingRoot = join(paths.deploymentRoot, "adoption", "staged", "node-binding");
  const bindingsRoot = join(paths.deploymentRoot, "node-bindings");
  ensureOwnedDirectory(bindingsRoot);
  let bindingId;
  if (existsSync(stagedBindingRoot)) {
    bindingId = stagedBindingId(stagedBindingRoot);
  } else {
    const bindings = readdirSync(bindingsRoot).filter((entry) => /^node-[0-9A-Za-z.+-]+-[a-f0-9]{12}$/.test(entry));
    if (bindings.length !== 1) throw new Error("adoption-binding-state-unsafe");
    [bindingId] = bindings;
  }
  const finalBindingRoot = join(bindingsRoot, bindingId);
  if (!existsSync(finalBindingRoot)) {
    chmodSync(stagedBindingRoot, 0o700);
    renameSync(stagedBindingRoot, finalBindingRoot);
    chmodSync(finalBindingRoot, 0o500);
  }
  atomicSymlink(`node-bindings/${bindingId}`, join(paths.deploymentRoot, "node-current"));
  inspectRuntimeBinding({ deploymentRoot: paths.deploymentRoot, requireExecutable: true });
}

function restoreAdoptionBackups(paths, journal) {
  const backupRoot = join(paths.deploymentRoot, "adoption", "backups");
  if (existsSync(join(backupRoot, "deployment.json"))) {
    rmSync(join(paths.deploymentRoot, "node-current"), { force: true });
    removeDeploymentTree(join(paths.deploymentRoot, "node-bindings"));
  }
  const replacements = [
    ["controller", join(paths.deploymentRoot, "controller")],
    ["controller.sha256", join(paths.deploymentRoot, "controller.sha256")],
    ["pi", paths.piWrapper],
    ["pi-gondolin-rpc", paths.launcherWrapper],
    ["deployment.json", paths.statePath],
  ];
  for (const [name, livePath] of replacements) {
    const backupPath = join(backupRoot, name);
    if (!existsSync(backupPath)) continue;
    if (existsSync(livePath)) rmSync(livePath, { recursive: true });
    renameSync(backupPath, livePath);
  }
  const launchdBackup = join(backupRoot, "launchd");
  if (existsSync(launchdBackup)) {
    run("/bin/launchctl", ["bootout", `gui/${process.getuid()}/${LAUNCH_AGENT_LABEL}`], { timeout: 10_000 });
    if (existsSync(paths.launchAgentPath)) rmSync(paths.launchAgentPath);
    renameSync(launchdBackup, paths.launchAgentPath);
    const loaded = run("/bin/launchctl", ["bootstrap", `gui/${process.getuid()}`, paths.launchAgentPath], { timeout: 10_000 });
    if (!resultPassed(loaded)) throw new Error("adoption-launch-agent-restore-refused");
  } else if (journal.artifacts.launchd.oldSha256 === ""
    && existsSync(paths.launchAgentPath)
    && launchdDigest(paths.launchAgentPath) === journal.artifacts.launchd.newSha256) {
    rmSync(paths.launchAgentPath);
  }
}

function verifyAdoptionArtifacts(paths, journal) {
  try {
    const actual = adoptionArtifactDigests(paths);
    const installedKeys = journal.phase === "launchd-loaded"
      ? Object.keys(journal.artifacts)
      : Object.keys(journal.artifacts).filter((key) => key !== "launchd");
    if (!installedKeys.every((key) => actual[key] === journal.artifacts[key].newSha256)) return false;
    if (journal.phase !== "launchd-loaded" || journal.artifacts.launchd.newSha256 === "") return true;
    const loaded = run("/bin/launchctl", ["print", `gui/${process.getuid()}/${LAUNCH_AGENT_LABEL}`], { timeout: 10_000 });
    return resultPassed(loaded);
  } catch {
    return false;
  }
}

function installAdoptionArtifacts(paths) {
  const adoptionRoot = join(paths.deploymentRoot, "adoption");
  const stagedRoot = join(adoptionRoot, "staged");
  const backupRoot = join(adoptionRoot, "backups");
  ensureOwnedDirectory(backupRoot);
  replaceAdoptionArtifact(
    join(paths.deploymentRoot, "controller"),
    join(stagedRoot, "controller"),
    join(backupRoot, "controller"),
  );
  replaceAdoptionArtifact(
    join(paths.deploymentRoot, "controller.sha256"),
    join(stagedRoot, "controller.sha256"),
    join(backupRoot, "controller.sha256"),
  );
  replaceAdoptionArtifact(paths.piWrapper, join(stagedRoot, "pi"), join(backupRoot, "pi"));
  replaceAdoptionArtifact(
    paths.launcherWrapper,
    join(stagedRoot, "pi-gondolin-rpc"),
    join(backupRoot, "pi-gondolin-rpc"),
  );
  replaceAdoptionArtifact(paths.statePath, join(stagedRoot, "deployment.json"), join(backupRoot, "deployment.json"));
}

async function finishAdoptionActivation(paths, journal, postActivationGate, runtimeAlreadyVerified = false) {
  let phase = journal.phase;
  if (phase === "artifacts-installed") {
    activateAdoptionBinding(paths);
    if (!await postActivationGate()) throw new Error("adoption-post-activation-refused");
    runtimeAlreadyVerified = true;
    advanceRuntimeAdoption({
      deploymentRoot: paths.deploymentRoot,
      expectedPhase: "artifacts-installed",
      nextPhase: "binding-active",
    });
    phase = "binding-active";
  }
  if (phase === "binding-active") {
    if (!runtimeAlreadyVerified && !await postActivationGate()) {
      throw new Error("adoption-post-activation-refused");
    }
    const stagedLaunchd = join(paths.deploymentRoot, "adoption", "staged", "launchd");
    const launchdBackup = join(paths.deploymentRoot, "adoption", "backups", "launchd");
    const state = readOwnedJson(paths.statePath);
    if (state.automation) {
      ensureOwnedDirectoryPreservingMode(dirname(paths.launchAgentPath));
      if (existsSync(stagedLaunchd)) {
        if (existsSync(paths.launchAgentPath) && !existsSync(launchdBackup)) {
          renameSync(paths.launchAgentPath, launchdBackup);
        }
        renameSync(stagedLaunchd, paths.launchAgentPath);
      }
      if (!existsSync(paths.launchAgentPath)
        || sha256(paths.launchAgentPath) !== state.automation.plistSha256) {
        throw new Error("adoption-launch-agent-integrity-refused");
      }
      run("/bin/launchctl", ["bootout", `gui/${process.getuid()}/${LAUNCH_AGENT_LABEL}`], { timeout: 10_000 });
      const loaded = run("/bin/launchctl", ["bootstrap", `gui/${process.getuid()}`, paths.launchAgentPath], { timeout: 10_000 });
      if (!resultPassed(loaded)) throw new Error("adoption-launch-agent-load-refused");
    }
    advanceRuntimeAdoption({
      deploymentRoot: paths.deploymentRoot,
      expectedPhase: "binding-active",
      nextPhase: "launchd-loaded",
    });
  }
}

async function recoverAdoption(paths, postActivationGate) {
  return recoverRuntimeAdoption({
    deploymentRoot: paths.deploymentRoot,
    verifyInstalled: async (journal) => verifyAdoptionArtifacts(paths, journal),
    restoreBackups: async (journal) => restoreAdoptionBackups(paths, journal),
    finishActivation: async (journal) => finishAdoptionActivation(paths, journal, postActivationGate),
  });
}

function removeOrphanedAdoptionCandidates(deploymentRoot) {
  for (const entry of readdirSync(deploymentRoot)) {
    if (!entry.startsWith(".adoption-candidate-")) continue;
    const path = join(deploymentRoot, entry);
    const stats = lstatSync(path);
    if (!stats.isDirectory() || stats.isSymbolicLink() || !isOwned(stats)) {
      throw new Error("adoption-candidate-path-unsafe");
    }
    removeDeploymentTree(path);
  }
}

export async function adoptRuntimeBindingV3({
  home,
  projectRoot,
  deploymentRoot: overrideRoot,
  interruptionPoint,
  qualificationGate,
  postActivationGate,
}) {
  if (interruptionPoint !== undefined
    && !["prepared", "artifacts-installed", "binding-active", "launchd-loaded"].includes(interruptionPoint)) {
    throw new Error("adoption-test-interruption-point-invalid");
  }
  if (qualificationGate !== undefined && typeof qualificationGate !== "function") {
    throw new Error("node-runtime-qualification-gate-invalid");
  }
  if (postActivationGate !== undefined && typeof postActivationGate !== "function") {
    throw new Error("adoption-post-activation-gate-invalid");
  }
  const paths = deploymentPaths(home, overrideRoot);
  const releaseLock = acquireUpdateLock(paths.deploymentRoot);
  const workRoot = join(paths.deploymentRoot, `.adoption-candidate-${process.pid}-${randomUUID()}`);
  let journalStarted = false;
  try {
    ensureOwnedDirectory(join(paths.deploymentRoot, "tmp"));
    const environment = buildRecoveryEnvironment({ deploymentRoot: paths.deploymentRoot, home });
    const activationGate = postActivationGate ?? (() => {
      const { release } = stateAndCurrent(paths);
      return postActivationSmoke(paths, release.packageVersion, environment);
    });
    const recovered = await recoverAdoption(paths, activationGate);
    if (recovered === "completed") {
      return deploymentStaticStatusV3({ home, deploymentRoot: paths.deploymentRoot });
    }
    removeOrphanedAdoptionCandidates(paths.deploymentRoot);
    const { state, releaseRoot } = stateAndCurrent(paths);
    if (state.runtimeBindingVersion === 1) {
      return deploymentStaticStatusV3({ home, deploymentRoot: paths.deploymentRoot });
    }
    const staticStatus = deploymentStaticStatusV3({ home, deploymentRoot: paths.deploymentRoot });
    if (!staticStatus.staticIntegrityPassed) throw new Error("deployment-pre-adoption-invalid");
    if (existsSync(join(paths.deploymentRoot, "node-current"))
      || existsSync(join(paths.deploymentRoot, "node-bindings"))) {
      throw new Error("adoption-binding-state-unsafe");
    }
    const oldAnchor = homebrewRecoveryAnchor(state.nodePath);
    const candidateNodePath = staticStatus.runtimeExecutable ? realpathSync(state.nodePath) : realpathSync(process.execPath);
    if (homebrewRecoveryAnchor(candidateNodePath) !== oldAnchor) throw new Error("node-runtime-recovery-mismatch");
    if (!staticStatus.runtimeExecutable && realpathSync(oldAnchor) !== candidateNodePath) {
      throw new Error("node-runtime-recovery-mismatch");
    }
    ensureOwnedDirectory(workRoot);
    const stagedRoot = join(workRoot, "staged");
    ensureOwnedDirectory(stagedRoot);
    stageAdoptionController({ projectRoot, deploymentRoot: paths.deploymentRoot, stagingRoot: stagedRoot });
    const [, npmPath] = resolveNpmCommand();
    const runtimeState = buildDeploymentRuntimeState({
      deploymentRoot: paths.deploymentRoot,
      canonicalNodePath: candidateNodePath,
      npmPath,
    });
    writeDeploymentWrappers(stagedRoot, paths.deploymentRoot, runtimeState.nodePath, runtimeState.nodeRecoveryPath);
    const nextState = {
      ...state,
      ...runtimeState,
      wrappers: {
        piSha256: sha256(join(stagedRoot, "pi")),
        launcherSha256: sha256(join(stagedRoot, "pi-gondolin-rpc")),
      },
    };
    if (state.automation) {
      const plist = renderLaunchAgentPlist({
        home,
        deploymentRoot: paths.deploymentRoot,
        piWrapperPath: paths.piWrapper,
        qemuPath: state.qemuPath,
      });
      atomicWrite(join(stagedRoot, "launchd"), plist);
      nextState.automation = { ...state.automation, plistSha256: sha256(join(stagedRoot, "launchd")) };
    }
    writeOwnedJson(join(stagedRoot, "deployment.json"), nextState);
    const bindingDeploymentRoot = join(workRoot, "binding");
    ensureOwnedDirectory(bindingDeploymentRoot);
    const gate = qualificationGate ?? ((context) => qualifyRelease({
      deploymentRoot: paths.deploymentRoot,
      releaseRoot: context.releaseRoot,
      nodePath: context.candidateNodePath,
      launcherPath: paths.launcherPath,
      environment: context.environment,
    }));
    const binding = await promoteRuntimeBinding({
      deploymentRoot: bindingDeploymentRoot,
      canonicalNodePath: candidateNodePath,
      nodeVersion: readNodeVersion(candidateNodePath, environment),
      qualifiedAt: new Date().toISOString(),
      source: "v3-adoption",
      qualificationGate: async () => gate({ candidateNodePath, releaseRoot, environment }),
    });
    const stagedBindingRoot = join(stagedRoot, "node-binding");
    chmodSync(binding.bindingRoot, 0o700);
    renameSync(binding.bindingRoot, stagedBindingRoot);
    chmodSync(stagedBindingRoot, 0o500);
    const oldDigests = adoptionArtifactDigests(paths);
    const stagedPaths = { ...paths, deploymentRoot: stagedRoot, statePath: join(stagedRoot, "deployment.json"), piWrapper: join(stagedRoot, "pi"), launcherWrapper: join(stagedRoot, "pi-gondolin-rpc"), launchAgentPath: join(stagedRoot, "launchd") };
    const newDigests = adoptionArtifactDigests(stagedPaths);
    beginRuntimeAdoption({
      deploymentRoot: paths.deploymentRoot,
      artifacts: adoptionArtifacts(oldDigests, newDigests),
    });
    journalStarted = true;
    renameSync(stagedRoot, join(paths.deploymentRoot, "adoption", "staged"));
    removeDeploymentTree(bindingDeploymentRoot);
    removeDeploymentTree(workRoot);
    maybeInterrupt(interruptionPoint, "prepared");
    installAdoptionArtifacts(paths);
    advanceRuntimeAdoption({
      deploymentRoot: paths.deploymentRoot,
      expectedPhase: "prepared",
      nextPhase: "artifacts-installed",
    });
    maybeInterrupt(interruptionPoint, "artifacts-installed");
    activateAdoptionBinding(paths);
    if (!await activationGate()) throw new Error("adoption-post-activation-refused");
    advanceRuntimeAdoption({
      deploymentRoot: paths.deploymentRoot,
      expectedPhase: "artifacts-installed",
      nextPhase: "binding-active",
    });
    maybeInterrupt(interruptionPoint, "binding-active");
    await finishAdoptionActivation(paths, { phase: "binding-active" }, activationGate, true);
    maybeInterrupt(interruptionPoint, "launchd-loaded");
    await recoverAdoption(paths, activationGate);
    return deploymentStaticStatusV3({ home, deploymentRoot: paths.deploymentRoot });
  } catch (error) {
    if (!journalStarted) removeDeploymentTree(workRoot);
    throw error;
  } finally {
    releaseLock();
  }
}

export async function installV3({
  home,
  projectRoot,
  deploymentRoot: overrideRoot,
  qualificationGate,
  postActivationGate,
}) {
  const paths = deploymentPaths(home, overrideRoot);
  if (existsSync(join(paths.deploymentRoot, "adoption"))) {
    return adoptRuntimeBindingV3({
      home,
      projectRoot,
      deploymentRoot: overrideRoot,
      qualificationGate,
      postActivationGate,
    });
  }
  if (existsSync(paths.statePath)) {
    const state = readOwnedJson(paths.statePath);
    if (state.version !== DEPLOYMENT_VERSION) throw new Error("deployment-state-version-invalid");
    if (state.runtimeBindingVersion !== 1) {
      return adoptRuntimeBindingV3({
        home,
        projectRoot,
        deploymentRoot: overrideRoot,
        qualificationGate,
        postActivationGate,
      });
    }
    return deploymentStatusV3({ home, deploymentRoot: overrideRoot });
  }
  if (existsSync(paths.deploymentRoot)) throw new Error("deployment-v3-path-exists");
  const legacyState = verifyLegacyDeployment(paths);
  const stagingRoot = `${paths.deploymentRoot}.candidate-${process.pid}-${randomUUID()}`;
  ensureOwnedDirectory(stagingRoot);
  const oldPiTarget = readlinkSync(paths.installedPi);
  const oldLauncherTarget = readlinkSync(paths.installedLauncher);
  let linksSwitched = false;
  try {
    copyRuntime(projectRoot, stagingRoot);
    const migrated = prepareMigratedRelease(paths, stagingRoot, legacyState);
    const canonicalNodePath = realpathSync(process.execPath);
    const [, npmPath] = resolveNpmCommand();
    const runtimeState = buildDeploymentRuntimeState({
      deploymentRoot: paths.deploymentRoot,
      canonicalNodePath,
      npmPath,
    });
    ensureOwnedDirectory(join(stagingRoot, "tmp"));
    const installEnvironment = buildRecoveryEnvironment({ deploymentRoot: stagingRoot, home });
    writeDeploymentWrappers(
      stagingRoot,
      paths.deploymentRoot,
      runtimeState.nodePath,
      runtimeState.nodeRecoveryPath,
    );
    await promoteRuntimeBinding({
      deploymentRoot: stagingRoot,
      canonicalNodePath,
      nodeVersion: readNodeVersion(canonicalNodePath, installEnvironment),
      qualifiedAt: new Date().toISOString(),
      source: "install",
      qualificationGate: async (candidateNodePath) => qualifyRelease({
        deploymentRoot: stagingRoot,
        releaseRoot: migrated.releaseRoot,
        nodePath: candidateNodePath,
        launcherPath: join(stagingRoot, "controller", "runtime", "experiments", "gondolin", "safe-rpc-launcher.mjs"),
        environment: installEnvironment,
      }),
    });
    const state = {
      ...runtimeState,
      profile: "gondolin-rpc-transactional-releases",
      qemuPath: resolveExecutable("qemu-system-aarch64"),
      packageName: PI_PACKAGE_NAME,
      currentRelease: migrated.releaseId,
      previousRelease: null,
      migratedFrom: { version: legacyState.version, packageVersion: legacyState.originalPi.version },
      wrappers: {
        piSha256: sha256(join(stagingRoot, "pi")),
        launcherSha256: sha256(join(stagingRoot, "pi-gondolin-rpc")),
      },
    };
    writeOwnedJson(join(stagingRoot, "deployment.json"), state);
    renameSync(stagingRoot, paths.deploymentRoot);
    linksSwitched = true;
    atomicSymlink(paths.piWrapper, paths.installedPi);
    atomicSymlink(paths.launcherWrapper, paths.installedLauncher);
    const deployedEnvironment = buildRecoveryEnvironment({ deploymentRoot: paths.deploymentRoot, home });
    if (!postActivationSmoke(paths, migrated.release.version, deployedEnvironment)) {
      throw new Error("migration-post-activation-refused");
    }
    const e2e = run(state.nodePath, [join(paths.deploymentRoot, "controller", "runtime", "experiments", "gondolin", "deployed-rpc-e2e.mjs")], {
      env: qualificationEnvironment({ PI_GONDOLIN_DEPLOYMENT_ROOT: paths.deploymentRoot }, deployedEnvironment),
      timeout: 240_000,
    });
    if (!resultPassed(e2e)) throw new Error("migration-deployed-e2e-refused");
    return deploymentStatusV3({ home, deploymentRoot: overrideRoot });
  } catch (error) {
    if (linksSwitched) {
      atomicSymlink(oldPiTarget, paths.installedPi);
      atomicSymlink(oldLauncherTarget, paths.installedLauncher);
    }
    removeDeploymentTree(stagingRoot);
    removeDeploymentTree(paths.deploymentRoot);
    throw error;
  }
}

function stateAndCurrent(paths) {
  const state = readOwnedJson(paths.statePath);
  if (state.version !== DEPLOYMENT_VERSION || state.packageName !== PI_PACKAGE_NAME) throw new Error("deployment-state-version-invalid");
  const releaseRoot = currentReleaseRoot(paths.deploymentRoot);
  const release = readReleaseMetadata(releaseRoot);
  return { state, releaseRoot, release };
}

function checkStaticIntegrity(check) {
  try {
    return check() === true;
  } catch {
    return false;
  }
}

function runtimeConfigurationStatus(paths, state) {
  if (state.runtimeBindingVersion === undefined) {
    const configured = typeof state.nodePath === "string"
      && Array.isArray(state.npmCommand)
      && state.npmCommand[0] === state.nodePath;
    const runtimeExecutable = checkStaticIntegrity(() => {
      const canonicalPath = realpathSync(state.nodePath);
      const stats = lstatSync(canonicalPath);
      return stats.isFile() && !stats.isSymbolicLink() && isOwned(stats) && (stats.mode & 0o111) !== 0;
    });
    return { runtimeConfigurationMatched: configured, runtimeExecutable };
  }

  const runtimeConfigurationMatched = checkStaticIntegrity(() => {
    inspectRuntimeBinding({ deploymentRoot: paths.deploymentRoot, requireExecutable: false });
    const stableNodePath = join(paths.deploymentRoot, "node-current", "node");
    return state.runtimeBindingVersion === 1
      && state.nodePath === stableNodePath
      && Array.isArray(state.npmCommand)
      && state.npmCommand[0] === stableNodePath
      && ["/opt/homebrew/opt/node/bin/node", "/usr/local/opt/node/bin/node"].includes(state.nodeRecoveryPath);
  });
  const runtimeExecutable = runtimeConfigurationMatched && checkStaticIntegrity(() => {
    inspectRuntimeBinding({ deploymentRoot: paths.deploymentRoot, requireExecutable: true });
    return true;
  });
  return { runtimeConfigurationMatched, runtimeExecutable };
}

export function deploymentStaticStatusV3({ home, deploymentRoot: overrideRoot }) {
  const paths = deploymentPaths(home, overrideRoot);
  let state;
  let releaseRoot;
  try {
    ({ state, releaseRoot } = stateAndCurrent(paths));
  } catch {
    return {
      controllerManifestMatched: false,
      runtimeManifestMatched: false,
      currentReleaseMatched: false,
      wrappersInstalled: false,
      wrapperHashesMatched: false,
      runtimeConfigurationMatched: false,
      runtimeExecutable: false,
      staticIntegrityPassed: false,
    };
  }
  const controllerManifestMatched = checkStaticIntegrity(
    () => verifyCriticalManifest(paths.deploymentRoot, join(paths.deploymentRoot, "controller.sha256")),
  );
  const runtimeManifestMatched = checkStaticIntegrity(
    () => verifyCriticalManifest(paths.deploymentRoot, join(paths.deploymentRoot, "runtime.sha256")),
  );
  const currentReleaseMatched = checkStaticIntegrity(
    () => verifyRelease(releaseRoot) && currentReleaseId(paths) === state.currentRelease,
  );
  const wrappersInstalled = checkStaticIntegrity(
    () => symlinkResolvesTo(paths.installedPi, paths.piWrapper)
      && symlinkResolvesTo(paths.installedLauncher, paths.launcherWrapper),
  );
  const wrapperHashesMatched = checkStaticIntegrity(
    () => sha256(paths.piWrapper) === state.wrappers?.piSha256
      && sha256(paths.launcherWrapper) === state.wrappers?.launcherSha256,
  );
  const runtimeStatus = runtimeConfigurationStatus(paths, state);
  return {
    controllerManifestMatched,
    runtimeManifestMatched,
    currentReleaseMatched,
    wrappersInstalled,
    wrapperHashesMatched,
    ...runtimeStatus,
    staticIntegrityPassed: controllerManifestMatched
      && runtimeManifestMatched
      && currentReleaseMatched
      && wrappersInstalled
      && wrapperHashesMatched
      && runtimeStatus.runtimeConfigurationMatched,
  };
}

export function deploymentStatusV3({ home, deploymentRoot: overrideRoot }) {
  const paths = deploymentPaths(home, overrideRoot);
  const staticStatus = deploymentStaticStatusV3({ home, deploymentRoot: overrideRoot });
  const { state, releaseRoot, release } = stateAndCurrent(paths);
  const canExecute = staticStatus.staticIntegrityPassed && staticStatus.runtimeExecutable;
  const refused = { status: null, stdout: "", stderr: "" };
  const version = canExecute
    ? run(paths.piWrapper, ["--version"], { env: qualificationEnvironment(), timeout: 10_000 })
    : refused;
  const direct = canExecute ? run(paths.piWrapper, ["--mode", "rpc"], { timeout: 10_000 }) : refused;
  const rpcEntry = canExecute
    ? run(state.nodePath, [join(packageRoot(releaseRoot), "dist", "rpc-entry.js")], { timeout: 10_000 })
    : refused;
  const incomplete = canExecute
    ? run(paths.launcherWrapper, [], {
        env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PI_GONDOLIN_"))),
        timeout: 10_000,
      })
    : refused;
  let automaticUpdateInstalled = false;
  if (state.automation?.plistSha256 && existsSync(paths.launchAgentPath)) {
    try {
      const stats = lstatSync(paths.launchAgentPath);
      automaticUpdateInstalled = stats.isFile()
        && !stats.isSymbolicLink()
        && isOwned(stats)
        && sha256(paths.launchAgentPath) === state.automation.plistSha256;
    } catch {
      automaticUpdateInstalled = false;
    }
  }
  const launchAgent = run("/bin/launchctl", ["print", `gui/${process.getuid()}/${LAUNCH_AGENT_LABEL}`], { timeout: 10_000 });
  const automaticUpdateLoaded = automaticUpdateInstalled && resultPassed(launchAgent);
  const deployed = staticStatus.staticIntegrityPassed
    && staticStatus.runtimeExecutable
    && resultPassed(version)
    && version.stdout.trim() === release.packageVersion
    && direct.status === 64
    && direct.stderr === "pi-rpc-launcher-required\n"
    && rpcEntry.status === 64
    && rpcEntry.stderr === "pi-rpc-launcher-required\n"
    && incomplete.status === 64
    && incomplete.stderr === "gondolin-rpc-launcher-refused\n";
  return {
    version: DEPLOYMENT_VERSION,
    deployed,
    profile: state.profile,
    currentVersion: release.packageVersion,
    previousReleaseAvailable: existsSync(join(paths.deploymentRoot, "previous")),
    blockedRelease: state.blockedRelease?.releaseId ?? null,
    ...staticStatus,
    directRpcRefused: direct.status === 64,
    directRpcEntryRefused: rpcEntry.status === 64,
    incompleteLauncherRefused: incomplete.status === 64,
    transactionalUpdateEnabled: true,
    automaticUpdateInstalled,
    automaticUpdateLoaded,
    sourceCheckoutRequired: false,
  };
}

function readNodeVersion(nodePath, environment) {
  const result = run(nodePath, ["--version"], { env: environment, timeout: 10_000 });
  const version = result.stdout.trim();
  if (!resultPassed(result)
    || !/^v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("node-runtime-version-invalid");
  }
  return version;
}

export async function runtimeRepinV3({ home, deploymentRoot: overrideRoot, qualificationGate }) {
  if (qualificationGate !== undefined && typeof qualificationGate !== "function") {
    throw new Error("node-runtime-qualification-gate-invalid");
  }
  const paths = deploymentPaths(home, overrideRoot);
  const releaseLock = acquireUpdateLock(paths.deploymentRoot);
  try {
    const status = deploymentStaticStatusV3({ home, deploymentRoot: paths.deploymentRoot });
    if (!status.staticIntegrityPassed) throw new Error("deployment-pre-repin-invalid");
    if (status.runtimeExecutable) throw new Error("node-runtime-still-healthy");
    const { state, releaseRoot } = stateAndCurrent(paths);
    const candidateNodePath = realpathSync(process.execPath);
    let recoveryMatches = false;
    try {
      recoveryMatches = homebrewRecoveryAnchor(candidateNodePath) === state.nodeRecoveryPath
        && realpathSync(state.nodeRecoveryPath) === candidateNodePath;
    } catch {
      recoveryMatches = false;
    }
    if (!recoveryMatches) throw new Error("node-runtime-recovery-mismatch");
    ensureOwnedDirectory(join(paths.deploymentRoot, "tmp"));
    const environment = buildRecoveryEnvironment({
      deploymentRoot: paths.deploymentRoot,
      home,
    });
    const gate = qualificationGate ?? ((context) => qualifyRelease({
      deploymentRoot: paths.deploymentRoot,
      releaseRoot: context.releaseRoot,
      nodePath: context.candidateNodePath,
      launcherPath: paths.launcherPath,
      environment: context.environment,
    }));
    return await promoteRuntimeBinding({
      deploymentRoot: paths.deploymentRoot,
      canonicalNodePath: candidateNodePath,
      nodeVersion: readNodeVersion(candidateNodePath, environment),
      qualifiedAt: new Date().toISOString(),
      source: "homebrew-recovery",
      qualificationGate: async () => gate({ candidateNodePath, releaseRoot, environment }),
    });
  } finally {
    releaseLock();
  }
}

export function enableAutomaticUpdatesV3({ home, deploymentRoot: overrideRoot }) {
  const paths = deploymentPaths(home, overrideRoot);
  const releaseLock = acquireUpdateLock(paths.deploymentRoot);
  try {
    const status = deploymentStatusV3({ home, deploymentRoot: overrideRoot });
    if (!status.deployed) throw new Error("deployment-pre-automation-invalid");
    const { state } = stateAndCurrent(paths);
    ensureOwnedDirectoryPreservingMode(dirname(paths.launchAgentPath));
    if (existsSync(paths.launchAgentPath)) {
      const stats = lstatSync(paths.launchAgentPath);
      if (!stats.isFile() || stats.isSymbolicLink() || !isOwned(stats)) throw new Error("launch-agent-path-unsafe");
    }
    const plist = renderLaunchAgentPlist({
      home,
      deploymentRoot: paths.deploymentRoot,
      piWrapperPath: paths.piWrapper,
      qemuPath: state.qemuPath,
    });
    atomicWrite(paths.launchAgentPath, plist);
    run("/bin/launchctl", ["bootout", `gui/${process.getuid()}/${LAUNCH_AGENT_LABEL}`], { timeout: 10_000 });
    state.automation = { label: LAUNCH_AGENT_LABEL, plistSha256: sha256(paths.launchAgentPath), intervalSeconds: 3600 };
    writeOwnedJson(paths.statePath, state);
    const bootstrap = run("/bin/launchctl", ["bootstrap", `gui/${process.getuid()}`, paths.launchAgentPath], { timeout: 10_000 });
    if (!resultPassed(bootstrap)) {
      delete state.automation;
      writeOwnedJson(paths.statePath, state);
      rmSync(paths.launchAgentPath);
      throw new Error("launch-agent-bootstrap-refused");
    }
    const loaded = run("/bin/launchctl", ["print", `gui/${process.getuid()}/${LAUNCH_AGENT_LABEL}`], { timeout: 10_000 });
    if (!resultPassed(loaded)) {
      run("/bin/launchctl", ["bootout", `gui/${process.getuid()}/${LAUNCH_AGENT_LABEL}`], { timeout: 10_000 });
      delete state.automation;
      writeOwnedJson(paths.statePath, state);
      rmSync(paths.launchAgentPath);
      throw new Error("launch-agent-status-refused");
    }
    return { enabled: true, loaded: true, intervalSeconds: 3600 };
  } finally {
    releaseLock();
  }
}

export function disableAutomaticUpdatesV3({ home, deploymentRoot: overrideRoot }) {
  const paths = deploymentPaths(home, overrideRoot);
  const releaseLock = acquireUpdateLock(paths.deploymentRoot);
  try {
    const { state } = stateAndCurrent(paths);
    run("/bin/launchctl", ["bootout", `gui/${process.getuid()}/${LAUNCH_AGENT_LABEL}`], { timeout: 10_000 });
    if (existsSync(paths.launchAgentPath)) {
      const stats = lstatSync(paths.launchAgentPath);
      if (!stats.isFile() || stats.isSymbolicLink() || !isOwned(stats)) throw new Error("launch-agent-path-unsafe");
      rmSync(paths.launchAgentPath);
    }
    delete state.automation;
    writeOwnedJson(paths.statePath, state);
    return { enabled: false, loaded: false };
  } finally {
    releaseLock();
  }
}

async function fetchLatestRelease() {
  const response = await fetch(LATEST_RELEASE_URL, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error("latest-release-request-refused");
  return response.json();
}

function resolveRegistryIntegrity(state, packageName, version) {
  const result = runCommand(state.npmCommand, ["view", `${packageName}@${version}`, "dist.integrity", "--json"], { timeout: 30_000 });
  if (!resultPassed(result)) throw new Error("registry-integrity-request-refused");
  let integrity;
  try {
    integrity = JSON.parse(result.stdout);
  } catch {
    throw new Error("registry-integrity-response-invalid");
  }
  if (typeof integrity !== "string") throw new Error("registry-integrity-response-invalid");
  return integrity;
}

function installCandidatePackage(state, candidateRoot, release) {
  ensureOwnedDirectory(candidateRoot);
  writeFileSync(join(candidateRoot, "package.json"), `${JSON.stringify({
    private: true,
    dependencies: { [release.packageName]: release.version },
  }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  const result = runCommand(state.npmCommand, [
    "install",
    "--prefix",
    candidateRoot,
    "--ignore-scripts",
    "--omit=dev",
    "--no-audit",
    "--no-fund",
    "--save-exact",
    "--min-release-age=0",
    `${release.packageName}@${release.version}`,
  ], { timeout: 180_000 });
  if (!resultPassed(result)) throw new Error("candidate-package-install-refused");
  verifyCandidatePackage(candidateRoot, release);
  auditPiPackageLicenses(packageRoot(candidateRoot));
  const rpcEntry = guardCandidateRpcEntry(candidateRoot);
  writeReleaseMetadata(candidateRoot, release, "npm-registry-exact", rpcEntry);
}

function currentReleaseId(paths) {
  const target = readlinkSync(join(paths.deploymentRoot, "current"));
  if (!target.startsWith("releases/")) throw new Error("current-release-unsafe");
  return basename(target);
}

function updateExtensionsIfRequested(paths, requested) {
  if (!requested) return;
  const extensionUpdate = run(paths.piWrapper, ["update", "--extensions"], { inherit: true, timeout: 180_000 });
  if (!resultPassed(extensionUpdate)) throw new Error("extension-update-refused");
}

function removeOwnedCandidate(candidateRoot, candidatesRoot) {
  if (!existsSync(candidateRoot)) return;
  const stats = lstatSync(candidateRoot);
  if (!stats.isDirectory() || stats.isSymbolicLink() || !isOwned(stats)) throw new Error("candidate-directory-unsafe");
  if (realpathSync(dirname(candidateRoot)) !== realpathSync(candidatesRoot)) throw new Error("candidate-path-invalid");
  rmSync(candidateRoot, { recursive: true });
}

export async function updateV3({ home, deploymentRoot: overrideRoot, force = false, updateExtensions = false }) {
  const paths = deploymentPaths(home, overrideRoot);
  const releaseLock = acquireUpdateLock(paths.deploymentRoot);
  let state;
  let attemptedReleaseId;
  try {
    ensureOwnedDirectory(join(paths.deploymentRoot, "tmp"));
    const environment = buildRecoveryEnvironment({ deploymentRoot: paths.deploymentRoot, home });
    const status = deploymentStatusV3({ home, deploymentRoot: overrideRoot });
    if (!status.deployed) throw new Error("deployment-pre-update-invalid");
    const current = stateAndCurrent(paths);
    state = current.state;
    const currentRelease = current.release;
    const latestPayload = await fetchLatestRelease();
    const validatedTarget = parseLatestRelease(latestPayload, "sha512-AA==");
    const preliminaryVersionOrder = compareVersions(validatedTarget.version, currentRelease.packageVersion);
    if (preliminaryVersionOrder < 0) throw new Error("release-downgrade-refused");
    if (preliminaryVersionOrder === 0 && !force) {
      updateExtensionsIfRequested(paths, updateExtensions);
      return { updated: false, currentVersion: currentRelease.packageVersion, reason: "already-current" };
    }
    const integrity = resolveRegistryIntegrity(state, validatedTarget.packageName, validatedTarget.version);
    const release = parseLatestRelease(latestPayload, integrity);
    const releaseId = releaseIdFor(release);
    attemptedReleaseId = releaseId;
    if (state.blockedRelease?.releaseId === releaseId && !force) {
      updateExtensionsIfRequested(paths, updateExtensions);
      return { updated: false, currentVersion: currentRelease.packageVersion, reason: "candidate-previously-refused" };
    }
    if (releaseId === currentReleaseId(paths) && force) {
      const currentRoot = currentReleaseRoot(paths.deploymentRoot);
      if (!qualifyRelease({
        deploymentRoot: paths.deploymentRoot,
        releaseRoot: currentRoot,
        nodePath: state.nodePath,
        launcherPath: paths.launcherPath,
        environment,
      })) throw new Error("current-release-requalification-refused");
      updateExtensionsIfRequested(paths, updateExtensions);
      return { updated: false, currentVersion: release.version, reason: "requalified-current" };
    }
    if (existsSync(join(paths.deploymentRoot, "releases", releaseId))) throw new Error("release-already-exists");
    const candidatesRoot = join(paths.deploymentRoot, "candidates");
    const candidateRoot = join(candidatesRoot, releaseId);
    ensureOwnedDirectory(candidatesRoot);
    removeOwnedCandidate(candidateRoot, candidatesRoot);
    installCandidatePackage(state, candidateRoot, release);
    const result = await promoteCandidate({
      deploymentRoot: paths.deploymentRoot,
      candidatePath: candidateRoot,
      releaseId,
      qualificationGates: [
        {
          name: "pi-gondolin-compatibility",
          run: async (path) => qualifyRelease({
            deploymentRoot: paths.deploymentRoot,
            releaseRoot: path,
            nodePath: state.nodePath,
            launcherPath: paths.launcherPath,
            environment,
          }),
        },
      ],
      postActivationGate: async () => postActivationSmoke(paths, release.version, environment),
    });
    const previousRelease = state.currentRelease;
    state.currentRelease = releaseId;
    state.previousRelease = previousRelease;
    delete state.blockedRelease;
    try {
      writeOwnedJson(paths.statePath, state);
    } catch {
      rollbackRelease(paths.deploymentRoot);
      throw new Error("deployment-state-update-refused");
    }
    updateExtensionsIfRequested(paths, updateExtensions);
    return { updated: true, fromVersion: currentRelease.packageVersion, toVersion: release.version, ...result };
  } catch (error) {
    const code = error instanceof Error ? error.message : "unknown";
    if (state && attemptedReleaseId && (code.startsWith("qualification-gate-refused:") || code === "post-activation-gate-refused")) {
      state.blockedRelease = { releaseId: attemptedReleaseId, reason: "compatibility-gate-refused" };
      try {
        writeOwnedJson(paths.statePath, state);
      } catch {
        throw new Error("deployment-state-update-refused");
      }
    }
    throw error;
  } finally {
    releaseLock();
  }
}

export function rollbackV3({ home, deploymentRoot: overrideRoot }) {
  const paths = deploymentPaths(home, overrideRoot);
  const releaseLock = acquireUpdateLock(paths.deploymentRoot);
  try {
    ensureOwnedDirectory(join(paths.deploymentRoot, "tmp"));
    const environment = buildRecoveryEnvironment({ deploymentRoot: paths.deploymentRoot, home });
    const { state } = stateAndCurrent(paths);
    const result = rollbackRelease(paths.deploymentRoot);
    const currentRoot = currentReleaseRoot(paths.deploymentRoot);
    const current = readReleaseMetadata(currentRoot);
    if (!postActivationSmoke(paths, current.packageVersion, environment)) {
      rollbackRelease(paths.deploymentRoot);
      throw new Error("rollback-post-activation-refused");
    }
    state.currentRelease = result.current;
    state.previousRelease = result.previous;
    state.blockedRelease = { releaseId: result.previous, reason: "manual-rollback" };
    writeOwnedJson(paths.statePath, state);
    return { ...result, currentVersion: current.packageVersion };
  } finally {
    releaseLock();
  }
}

function delegateToCurrentPi(paths, args) {
  const releaseRoot = currentReleaseRoot(paths.deploymentRoot);
  if (!verifyRelease(releaseRoot)) throw new Error("current-release-integrity-refused");
  const { state } = stateAndCurrent(paths);
  const result = run(state.nodePath, [join(packageRoot(releaseRoot), "dist", "cli.js"), ...args], {
    inherit: true,
    timeout: 180_000,
  });
  return commandStatus(result);
}

export async function routePiRequest({ home, deploymentRoot: overrideRoot, args }) {
  const paths = deploymentPaths(home, overrideRoot);
  const target = classifyUpdateRequest(args);
  if (target.kind === "refuse") throw new Error("update-target-refused");
  if (target.kind !== "self") return { exitCode: delegateToCurrentPi(paths, args) };
  const result = await updateV3({
    home,
    deploymentRoot: overrideRoot,
    force: target.force,
    updateExtensions: target.updateExtensions,
  });
  return { exitCode: 0, result };
}
