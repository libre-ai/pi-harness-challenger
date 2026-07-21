#!/usr/bin/env node
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
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const action = process.argv[2] ?? "status";
if (!["install", "status", "rollback"].includes(action) || process.argv.length > 3) {
  process.stderr.write("usage: deploy-local.mjs install|status|rollback\n");
  process.exit(64);
}

const experimentRoot = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(experimentRoot, "../..");
const home = homedir();
const binDirectory = join(home, ".local", "bin");
const deploymentDirectory = join(home, ".local", "share", "pi-harness-challenger", "gondolin-rpc");
const statePath = join(deploymentDirectory, "deployment.json");
const manifestPath = join(deploymentDirectory, "runtime.sha256");
const piWrapperPath = join(deploymentDirectory, "pi");
const launcherWrapperPath = join(deploymentDirectory, "pi-gondolin-rpc");
const rpcEntryBackupPath = join(deploymentDirectory, "rpc-entry.original.js");
const installedPiPath = join(binDirectory, "pi");
const installedLauncherPath = join(binDirectory, "pi-gondolin-rpc");
const launcherPath = join(experimentRoot, "safe-rpc-launcher.mjs");
const exceptionPath = join(experimentRoot, "license-exception.json");
const expectedPiVersion = "0.80.10";
const expectedRpcEntrySha256 = "7c3b46714f2d357f8b0d5403164663b60c13e62ef14dfc360ee757bdc16e02a0";
const expectedLicense = Object.freeze({
  licenseSha256: "88d9b4eb60579c191ec391ca04c16130572d7eedc4a86daa58bf28c6e14c9bcd",
  packageJsonSha256: "4d4e7122e483ab7bed48c884bb0de1471d3cb3753e1a334e3aafa3c32c22923e",
  runtimeFileSha256: "432333a18cef679d16c71328fcc18cc547e58d7d1c2b880a581b2d7ee4248027",
});
const runtimeRelativePaths = [
  "experiments/gondolin/safe-rpc-launcher.mjs",
  "experiments/gondolin/rpc-gate.mjs",
  "experiments/gondolin/snapshot.mjs",
  "experiments/gondolin/extension.mjs",
  "experiments/gondolin/sandbox.mjs",
  "experiments/gondolin/package.json",
  "experiments/gondolin/package-lock.json",
  "experiments/gondolin/license-exception.json",
  "extensions/policy-gate/index.mjs",
  "extensions/policy-gate/policy.mjs",
  "extensions/policy-gate/capabilities.mjs",
  "extensions/shared/config.mjs",
];

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function ensureOwnedDirectory(path, mode) {
  mkdirSync(path, { recursive: true, mode });
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink() || stats.uid !== process.getuid()) {
    throw new Error("deployment-directory-unsafe");
  }
  chmodSync(path, mode);
}

function atomicWrite(path, content, mode) {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, content, { mode, flag: "wx" });
  renameSync(temporary, path);
  chmodSync(path, mode);
}

function atomicSymlink(target, path) {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  symlinkSync(target, temporary);
  renameSync(temporary, path);
}

function verifyLicenseException() {
  const approval = JSON.parse(readFileSync(exceptionPath, "utf8"));
  if (approval.approved !== true
    || approval.scope?.backend !== "@earendil-works/gondolin@0.12.0"
    || approval.scope?.package !== "tweetnacl@0.14.5"
    || approval.constraints?.noBroaderUnlicenseApproval !== true
    || approval.constraints?.reevaluateOnVersionOrHashChange !== true) {
    throw new Error("license-exception-not-approved");
  }
  const packageRoot = join(experimentRoot, "node_modules", "tweetnacl");
  const actual = {
    licenseSha256: sha256(join(packageRoot, "LICENSE")),
    packageJsonSha256: sha256(join(packageRoot, "package.json")),
    runtimeFileSha256: sha256(join(packageRoot, "nacl-fast.js")),
  };
  if (JSON.stringify(actual) !== JSON.stringify(expectedLicense)
    || Object.entries(expectedLicense).some(([key, value]) => approval.artifacts?.[key] !== value)) {
    throw new Error("license-exception-artifact-mismatch");
  }
  const gondolinPackage = JSON.parse(readFileSync(join(experimentRoot, "node_modules", "@earendil-works", "gondolin", "package.json"), "utf8"));
  if (gondolinPackage.version !== "0.12.0") throw new Error("gondolin-version-not-approved");
  return actual;
}

function runtimeManifest() {
  return runtimeRelativePaths.map((path) => {
    const absolutePath = join(projectRoot, path);
    if (!existsSync(absolutePath)) throw new Error(`deployment-runtime-missing:${path}`);
    return { path, absolutePath, sha256: sha256(absolutePath) };
  });
}

function guardedRpcEntry() {
  return `#!/usr/bin/env node\nprocess.stderr.write("pi-rpc-launcher-required\\n");\nprocess.exit(64);\n`;
}

function piWrapper(realPiPath, realPiSha, launcherSha, rpcEntryPath, rpcEntrySha) {
  return `#!/bin/sh
set -eu
REAL_PI=${shellQuote(realPiPath)}
REAL_PI_SHA=${shellQuote(realPiSha)}
LAUNCHER=${shellQuote(launcherPath)}
LAUNCHER_SHA=${shellQuote(launcherSha)}
RPC_ENTRY=${shellQuote(rpcEntryPath)}
RPC_ENTRY_SHA=${shellQuote(rpcEntrySha)}
NODE=${shellQuote(process.execPath)}
RPC=0
EXPECT_MODE=0
FIRST_ARG=1
for ARG in "$@"; do
  if [ "$FIRST_ARG" -eq 1 ]; then
    [ "$ARG" = "update" ] && { printf '%s\\n' 'pi-update-requires-gondolin-rollback' >&2; exit 64; }
    FIRST_ARG=0
  fi
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
  refuse() { printf '%s\\n' 'pi-rpc-launcher-required' >&2; exit 64; }
  [ "\${PI_GONDOLIN_RPC_ACTIVE-}" = "1" ] || refuse
  PARENT_COMMAND=$(/bin/ps -p "$PPID" -o command= 2>/dev/null || true)
  case "$PARENT_COMMAND" in *"$LAUNCHER"*) ;; *) refuse ;; esac
  [ "$(/usr/bin/shasum -a 256 "$REAL_PI" | /usr/bin/awk '{print $1}')" = "$REAL_PI_SHA" ] || refuse
  [ "$(/usr/bin/shasum -a 256 "$LAUNCHER" | /usr/bin/awk '{print $1}')" = "$LAUNCHER_SHA" ] || refuse
  [ "$(/usr/bin/shasum -a 256 "$RPC_ENTRY" | /usr/bin/awk '{print $1}')" = "$RPC_ENTRY_SHA" ] || refuse
  unset PI_GONDOLIN_RPC_ACTIVE
fi
exec "$NODE" "$REAL_PI" "$@"
`;
}

function launcherWrapper(rpcEntryPath, rpcEntrySha) {
  return `#!/bin/sh
set -eu
MANIFEST=${shellQuote(manifestPath)}
NODE=${shellQuote(process.execPath)}
LAUNCHER=${shellQuote(launcherPath)}
RPC_ENTRY=${shellQuote(rpcEntryPath)}
RPC_ENTRY_SHA=${shellQuote(rpcEntrySha)}
[ "$(/usr/bin/shasum -a 256 "$RPC_ENTRY" | /usr/bin/awk '{print $1}')" = "$RPC_ENTRY_SHA" ] || {
  printf '%s\\n' 'gondolin-rpc-deployment-integrity-refused' >&2
  exit 65
}
/usr/bin/shasum -a 256 -c "$MANIFEST" >/dev/null 2>&1 || {
  printf '%s\\n' 'gondolin-rpc-deployment-integrity-refused' >&2
  exit 65
}
exec "$NODE" "$LAUNCHER"
`;
}

function readState() {
  const stats = lstatSync(statePath);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.uid !== process.getuid() || (stats.mode & 0o077) !== 0) {
    throw new Error("deployment-state-unsafe");
  }
  return JSON.parse(readFileSync(statePath, "utf8"));
}

function symlinkResolvesTo(path, expected) {
  try {
    return lstatSync(path).isSymbolicLink() && realpathSync(path) === realpathSync(expected);
  } catch {
    return false;
  }
}

function deploymentStatus() {
  const state = readState();
  const manifest = runtimeManifest();
  const license = verifyLicenseException();
  const manifestMatches = manifest.every((entry) => state.runtime?.[entry.path] === entry.sha256)
    && sha256(manifestPath) === state.artifacts?.manifestSha256;
  const wrappersInstalled = symlinkResolvesTo(installedPiPath, piWrapperPath)
    && symlinkResolvesTo(installedLauncherPath, launcherWrapperPath);
  const wrapperHashesMatch = sha256(piWrapperPath) === state.artifacts?.piWrapperSha256
    && sha256(launcherWrapperPath) === state.artifacts?.launcherWrapperSha256;
  const piArtifactMatches = sha256(state.originalPi.realPath) === state.originalPi.sha256;
  const rpcEntryGuarded = sha256(state.originalRpcEntry.path) === state.originalRpcEntry.guardedSha256;
  const rpcEntry = spawnSync(process.execPath, [state.originalRpcEntry.path], { encoding: "utf8", timeout: 10_000 });
  const directRpcEntryRefused = rpcEntry.status === 64
    && rpcEntry.stdout === ""
    && rpcEntry.stderr === "pi-rpc-launcher-required\n";
  const update = spawnSync(installedPiPath, ["update", "pi"], { encoding: "utf8", timeout: 10_000 });
  const piUpdateRefused = update.status === 64
    && update.stdout === ""
    && update.stderr === "pi-update-requires-gondolin-rollback\n";
  const direct = spawnSync(installedPiPath, ["--mode", "rpc"], {
    encoding: "utf8",
    env: { ...process.env, PI_GONDOLIN_RPC_ACTIVE: "" },
    timeout: 10_000,
  });
  const directRpcRefused = direct.status === 64 && direct.stdout === "" && direct.stderr === "pi-rpc-launcher-required\n";
  const incomplete = spawnSync(installedLauncherPath, [], {
    encoding: "utf8",
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PI_GONDOLIN_"))),
    timeout: 10_000,
  });
  const incompleteLauncherRefused = incomplete.status === 64
    && incomplete.stdout === ""
    && incomplete.stderr === "gondolin-rpc-launcher-refused\n";
  const version = spawnSync(installedPiPath, ["--version"], { encoding: "utf8", timeout: 10_000 });
  const interactivePiPreserved = version.status === 0 && version.stdout.trim() === expectedPiVersion;
  const deployed = state.version === 2
    && manifestMatches
    && wrappersInstalled
    && wrapperHashesMatch
    && piArtifactMatches
    && rpcEntryGuarded
    && directRpcEntryRefused
    && piUpdateRefused
    && directRpcRefused
    && incompleteLauncherRefused
    && interactivePiPreserved;
  return {
    version: 2,
    deployed,
    licenseExceptionApproved: true,
    licenseArtifactsMatched: JSON.stringify(license) === JSON.stringify(expectedLicense),
    runtimeManifestMatched: manifestMatches,
    wrappersInstalled,
    wrapperHashesMatched: wrapperHashesMatch,
    piArtifactMatched: piArtifactMatches,
    rpcEntryGuarded,
    directRpcEntryRefused,
    piUpdateRefused,
    directRpcRefused,
    incompleteLauncherRefused,
    interactivePiPreserved,
    challengerExtensionsGloballyConfigured: false,
    rollbackAvailable: true,
  };
}

function install() {
  ensureOwnedDirectory(binDirectory, 0o755);
  if (existsSync(statePath)) {
    const current = deploymentStatus();
    if (!current.deployed) throw new Error("deployment-existing-invalid");
    return current;
  }
  const binStats = lstatSync(binDirectory);
  if (binStats.isSymbolicLink() || binStats.uid !== process.getuid()) throw new Error("deployment-bin-unsafe");
  const piStats = lstatSync(installedPiPath);
  if (!piStats.isSymbolicLink()) throw new Error("deployment-original-pi-not-symlink");
  if (existsSync(installedLauncherPath)) throw new Error("deployment-launcher-path-exists");
  const originalTarget = readlinkSync(installedPiPath);
  const realPiPath = realpathSync(installedPiPath);
  const piPackageRoot = resolve(dirname(realPiPath), "..");
  const piPackage = JSON.parse(readFileSync(join(piPackageRoot, "package.json"), "utf8"));
  if (piPackage.version !== expectedPiVersion) throw new Error("deployment-pi-version-mismatch");
  const rpcEntryPath = join(piPackageRoot, "dist", "rpc-entry.js");
  const rpcEntryStats = lstatSync(rpcEntryPath);
  if (!rpcEntryStats.isFile() || rpcEntryStats.isSymbolicLink() || sha256(rpcEntryPath) !== expectedRpcEntrySha256) {
    throw new Error("deployment-rpc-entry-artifact-mismatch");
  }
  const originalRpcEntry = readFileSync(rpcEntryPath);
  const rpcGuard = guardedRpcEntry();
  const rpcGuardSha = createHash("sha256").update(rpcGuard).digest("hex");
  const license = verifyLicenseException();
  const manifest = runtimeManifest();
  const realPiSha = sha256(realPiPath);
  const launcherSha = sha256(launcherPath);

  ensureOwnedDirectory(deploymentDirectory, 0o700);
  let launcherInstalled = false;
  let piInstalled = false;
  let rpcEntryPatched = false;
  try {
    atomicWrite(rpcEntryBackupPath, originalRpcEntry, 0o600);
    atomicWrite(rpcEntryPath, rpcGuard, rpcEntryStats.mode & 0o777);
    rpcEntryPatched = true;
    const manifestContent = `${manifest.map((entry) => `${entry.sha256}  ${entry.absolutePath}`).join("\n")}\n`;
    atomicWrite(manifestPath, manifestContent, 0o600);
    atomicWrite(piWrapperPath, piWrapper(realPiPath, realPiSha, launcherSha, rpcEntryPath, rpcGuardSha), 0o700);
    atomicWrite(launcherWrapperPath, launcherWrapper(rpcEntryPath, rpcGuardSha), 0o700);
    const state = {
      version: 2,
      deployedAt: new Date().toISOString(),
      profile: "gondolin-rpc-exclusive-cli-entrypoint",
      originalPi: { target: originalTarget, realPath: realPiPath, sha256: realPiSha, version: expectedPiVersion },
      originalRpcEntry: {
        path: rpcEntryPath,
        originalSha256: expectedRpcEntrySha256,
        guardedSha256: rpcGuardSha,
        backupSha256: sha256(rpcEntryBackupPath),
        mode: rpcEntryStats.mode & 0o777,
      },
      runtime: Object.fromEntries(manifest.map((entry) => [entry.path, entry.sha256])),
      license,
      artifacts: {
        manifestSha256: sha256(manifestPath),
        piWrapperSha256: sha256(piWrapperPath),
        launcherWrapperSha256: sha256(launcherWrapperPath),
      },
    };
    atomicWrite(statePath, `${JSON.stringify(state, null, 2)}\n`, 0o600);
    atomicSymlink(launcherWrapperPath, installedLauncherPath);
    launcherInstalled = true;
    atomicSymlink(piWrapperPath, installedPiPath);
    piInstalled = true;
    const status = deploymentStatus();
    if (!status.deployed) throw new Error("deployment-postcondition-failed");
    return status;
  } catch (error) {
    if (piInstalled) atomicSymlink(originalTarget, installedPiPath);
    if (launcherInstalled && symlinkResolvesTo(installedLauncherPath, launcherWrapperPath)) rmSync(installedLauncherPath);
    if (rpcEntryPatched) atomicWrite(rpcEntryPath, originalRpcEntry, rpcEntryStats.mode & 0o777);
    rmSync(deploymentDirectory, { recursive: true, force: true });
    throw error;
  }
}

function rollback() {
  const state = readState();
  if (!symlinkResolvesTo(installedPiPath, piWrapperPath)
    || !symlinkResolvesTo(installedLauncherPath, launcherWrapperPath)) {
    throw new Error("deployment-rollback-current-links-mismatch");
  }
  let rpcEntryRestored = true;
  if (state.originalRpcEntry) {
    if (sha256(state.originalRpcEntry.path) !== state.originalRpcEntry.guardedSha256
      || sha256(rpcEntryBackupPath) !== state.originalRpcEntry.backupSha256) {
      throw new Error("deployment-rollback-rpc-entry-mismatch");
    }
    atomicWrite(state.originalRpcEntry.path, readFileSync(rpcEntryBackupPath), state.originalRpcEntry.mode);
    rpcEntryRestored = sha256(state.originalRpcEntry.path) === state.originalRpcEntry.originalSha256;
  }
  atomicSymlink(state.originalPi.target, installedPiPath);
  rmSync(installedLauncherPath);
  rmSync(deploymentDirectory, { recursive: true, force: true });
  const restored = lstatSync(installedPiPath).isSymbolicLink()
    && readlinkSync(installedPiPath) === state.originalPi.target
    && realpathSync(installedPiPath) === state.originalPi.realPath;
  return { version: 2, rolledBack: restored && rpcEntryRestored, rpcEntryRestored, launcherRemoved: !existsSync(installedLauncherPath) };
}

try {
  const result = action === "install" ? install() : action === "rollback" ? rollback() : deploymentStatus();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`gondolin-rpc-deployment-refused:${error instanceof Error ? error.message : "unknown"}\n`);
  process.exitCode = 1;
}
