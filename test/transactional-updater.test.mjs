import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  adoptRuntimeBindingV3,
  auditPiPackageLicenses,
  buildDeploymentRuntimeState,
  deploymentStaticStatusV3,
  installV3,
  renderLaunchAgentPlist,
  renderStableLauncherWrapper,
  renderStablePiWrapper,
  runtimeRepinV3,
  verifyCandidatePackage,
} from "../experiments/gondolin/deployment-controller.mjs";
import {
  buildRecoveryEnvironment,
  homebrewRecoveryAnchor,
  inspectRuntimeBinding,
  promoteRuntimeBinding,
} from "../experiments/gondolin/runtime-binding.mjs";
import {
  acquireUpdateLock,
  buildCriticalManifest,
  classifyUpdateRequest,
  compareVersions,
  parseLatestRelease,
  promoteCandidate,
  releaseIdFor,
  rollbackRelease,
  verifyCriticalManifest,
} from "../experiments/gondolin/release-manager.mjs";

function temporaryRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return {
    root,
    cleanup: () => {
      makeTreeWritable(root);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function makeTreeWritable(path) {
  if (!existsSync(path)) return;
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) return;
  if (stats.isDirectory()) {
    chmodSync(path, 0o700);
    for (const entry of readdirSync(path)) makeTreeWritable(join(path, entry));
  }
}

function resolvedLink(path) {
  return readlinkSync(path);
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hashTree(root, current = root) {
  const hash = createHash("sha256");
  for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(current, entry.name);
    const relativePath = path.slice(root.length + 1);
    hash.update(relativePath);
    if (entry.isSymbolicLink()) hash.update(`link:${readlinkSync(path)}`);
    else if (entry.isDirectory()) hash.update(hashTree(root, path));
    else hash.update(readFileSync(path));
  }
  return hash.digest("hex");
}

function staticDeploymentFixture({
  canonicalNodePath = "/opt/homebrew/Cellar/node/0.0.0-missing/bin/node",
  nodeVersion = "v0.0.0",
  runtimeBinding = true,
} = {}) {
  const temporary = temporaryRoot("pi-static-deployment-");
  const root = join(temporary.root, "deployment");
  const home = join(temporary.root, "home");
  const releaseId = "0.84.2-test";
  const releaseRoot = join(root, "releases", releaseId);
  const previousReleaseId = "0.84.1-test";
  const previousReleaseRoot = join(root, "releases", previousReleaseId);
  const controllerPath = join(root, "controller", "deployment-controller.mjs");
  const runtimePath = join(root, "controller", "runtime", "runtime-entry.mjs");
  const piWrapper = join(root, "pi");
  const launcherWrapper = join(root, "pi-gondolin-rpc");
  const markerPath = join(temporary.root, "execution-marker");
  const qualifiedAt = "2026-09-09T00:00:00.000Z";
  const bindingId = `node-${nodeVersion.slice(1)}-${sha256Text(`${canonicalNodePath}\0${nodeVersion}\0${qualifiedAt}`).slice(0, 12)}`;
  const bindingRoot = join(root, "node-bindings", bindingId);

  mkdirSync(dirname(controllerPath), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(runtimePath), { recursive: true, mode: 0o700 });
  mkdirSync(releaseRoot, { recursive: true, mode: 0o700 });
  if (runtimeBinding) mkdirSync(bindingRoot, { recursive: true, mode: 0o700 });
  mkdirSync(join(home, ".local", "bin"), { recursive: true, mode: 0o700 });
  writeFileSync(controllerPath, "controller\n", { mode: 0o600 });
  writeFileSync(runtimePath, "runtime\n", { mode: 0o600 });
  buildCriticalManifest(root, ["controller/deployment-controller.mjs"], join(root, "controller.sha256"));
  buildCriticalManifest(root, ["controller/runtime/runtime-entry.mjs"], join(root, "runtime.sha256"));

  const releaseMetadata = `${JSON.stringify({
    version: 1,
    packageName: "@earendil-works/pi-coding-agent",
    packageVersion: "0.84.2",
    integrity: "sha512-test",
    source: "test",
  }, null, 2)}\n`;
  writeFileSync(join(releaseRoot, "release.json"), releaseMetadata, { mode: 0o600 });
  buildCriticalManifest(releaseRoot, ["release.json"], join(releaseRoot, "critical.sha256"));
  mkdirSync(previousReleaseRoot, { recursive: true, mode: 0o700 });
  writeFileSync(join(previousReleaseRoot, "release.json"), releaseMetadata, { mode: 0o600 });
  buildCriticalManifest(previousReleaseRoot, ["release.json"], join(previousReleaseRoot, "critical.sha256"));
  symlinkSync(`releases/${releaseId}`, join(root, "current"));
  symlinkSync(`releases/${previousReleaseId}`, join(root, "previous"));

  const instrumentedWrapper = `#!/bin/sh\nprintf invoked > ${markerPath}\nexit 64\n`;
  writeFileSync(piWrapper, instrumentedWrapper, { mode: 0o700 });
  writeFileSync(launcherWrapper, instrumentedWrapper, { mode: 0o700 });
  symlinkSync(piWrapper, join(home, ".local", "bin", "pi"));
  symlinkSync(launcherWrapper, join(home, ".local", "bin", "pi-gondolin-rpc"));

  const bindingMetadata = `${JSON.stringify({
    runtimeBindingVersion: 1,
    bindingId,
    canonicalNodePath,
    nodeVersion,
    qualifiedAt,
    recoverySource: "homebrew",
  }, null, 2)}\n`;
  if (runtimeBinding) {
    writeFileSync(join(bindingRoot, "binding.json"), bindingMetadata, { mode: 0o400 });
    symlinkSync(canonicalNodePath, join(bindingRoot, "node"));
    writeFileSync(
      join(bindingRoot, "binding.sha256"),
      `${sha256Text(bindingMetadata)}  binding.json\n${sha256Text(canonicalNodePath)}  node.target\n`,
      { mode: 0o400 },
    );
    chmodSync(bindingRoot, 0o500);
    symlinkSync(`node-bindings/${bindingId}`, join(root, "node-current"));
  }

  const nodePath = runtimeBinding ? join(root, "node-current", "node") : canonicalNodePath;
  const state = {
    version: 3,
    profile: "gondolin-rpc-transactional-releases",
    nodePath,
    npmCommand: [nodePath, "/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js"],
    qemuPath: "/opt/homebrew/bin/qemu-system-aarch64",
    packageName: "@earendil-works/pi-coding-agent",
    currentRelease: releaseId,
    previousRelease: previousReleaseId,
    wrappers: {
      piSha256: sha256Text(instrumentedWrapper),
      launcherSha256: sha256Text(instrumentedWrapper),
    },
  };
  if (runtimeBinding) {
    state.runtimeBindingVersion = 1;
    state.nodeRecoveryPath = homebrewRecoveryAnchor(canonicalNodePath);
  }
  writeFileSync(join(root, "deployment.json"), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });

  return {
    root,
    home,
    paths: {
      bindingManifest: join(bindingRoot, "binding.sha256"),
      controllerPath,
      current: join(root, "current"),
      installedPi: join(home, ".local", "bin", "pi"),
      piWrapper,
      releaseMetadata: join(releaseRoot, "release.json"),
      runtimePath,
      statePath: join(root, "deployment.json"),
    },
    executionCount: () => existsSync(markerPath) ? 1 : 0,
    cleanup: () => {
      if (existsSync(join(root, "node-bindings"))) {
        for (const entry of readdirSync(join(root, "node-bindings"))) {
          chmodSync(join(root, "node-bindings", entry), 0o700);
        }
      }
      temporary.cleanup();
    },
  };
}

async function runtimeLifecycleFixture() {
  const temporary = temporaryRoot("pi-runtime-lifecycle-");
  const root = join(temporary.root, "deployment");
  const home = join(temporary.root, "home");
  const controllerRoot = join(root, "controller");
  const runtimeRoot = join(controllerRoot, "runtime");
  const runtimeExperimentRoot = join(runtimeRoot, "experiments", "gondolin");
  const packageRoot = join(root, "releases", "0.1.0-test", "node_modules", "@earendil-works", "pi-coding-agent");
  const releaseRoot = join(root, "releases", "0.1.0-test");
  const sourceRoot = fileURLToPath(new URL("..", import.meta.url));
  const recoveryCanonicalNode = realpathSync(process.execPath);
  const nodeRecoveryPath = homebrewRecoveryAnchor(recoveryCanonicalNode);
  const oldKeg = join(temporary.root, "old-keg");
  const oldNode = join(oldKeg, "bin", "node");

  mkdirSync(controllerRoot, { recursive: true, mode: 0o700 });
  mkdirSync(runtimeExperimentRoot, { recursive: true, mode: 0o700 });
  mkdirSync(join(runtimeRoot, "scripts"), { recursive: true, mode: 0o700 });
  mkdirSync(join(packageRoot, "dist"), { recursive: true, mode: 0o700 });
  mkdirSync(join(home, ".local", "bin"), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(oldNode), { recursive: true, mode: 0o700 });

  const controllerFiles = [
    "deployment-controller.mjs",
    "release-manager.mjs",
    "runtime-adoption.mjs",
    "runtime-binding.mjs",
    "update-local.mjs",
  ];
  for (const file of controllerFiles) {
    cpSync(join(sourceRoot, "experiments", "gondolin", file), join(controllerRoot, file));
  }
  writeFileSync(join(runtimeExperimentRoot, "safe-rpc-launcher.mjs"), "process.exit(64);\n", { mode: 0o600 });
  writeFileSync(join(runtimeExperimentRoot, "deployed-rpc-e2e.mjs"), "process.exit(0);\n", { mode: 0o600 });
  writeFileSync(join(runtimeExperimentRoot, "budget-test.mjs"), "process.exit(0);\n", { mode: 0o600 });
  writeFileSync(
    join(runtimeRoot, "scripts", "sandbox-license-audit.mjs"),
    "process.stdout.write('{\"allPass\":true}\\n');\n",
    { mode: 0o600 },
  );
  buildCriticalManifest(
    root,
    controllerFiles.map((file) => `controller/${file}`),
    join(root, "controller.sha256"),
  );
  buildCriticalManifest(root, [
    "controller/runtime/experiments/gondolin/budget-test.mjs",
    "controller/runtime/experiments/gondolin/deployed-rpc-e2e.mjs",
    "controller/runtime/experiments/gondolin/safe-rpc-launcher.mjs",
    "controller/runtime/scripts/sandbox-license-audit.mjs",
  ], join(root, "runtime.sha256"));

  const packageJson = {
    name: "@earendil-works/pi-coding-agent",
    version: "0.1.0",
    license: "MIT",
    bin: { pi: "dist/cli.js" },
  };
  writeFileSync(join(packageRoot, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(
    join(packageRoot, "dist", "cli.js"),
    "if (process.argv.includes('--version')) process.stdout.write('0.1.0\\n');\n",
    { mode: 0o600 },
  );
  writeFileSync(
    join(packageRoot, "dist", "rpc-entry.js"),
    "process.stderr.write('pi-rpc-launcher-required\\n'); process.exit(64);\n",
    { mode: 0o600 },
  );
  writeFileSync(join(packageRoot, "npm-shrinkwrap.json"), `${JSON.stringify({
    packages: { "": { license: "MIT" } },
  }, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(join(releaseRoot, "release.json"), `${JSON.stringify({
    version: 1,
    packageName: "@earendil-works/pi-coding-agent",
    packageVersion: "0.1.0",
    integrity: "sha512-test",
    source: "test",
    rpcEntry: {},
  }, null, 2)}\n`, { mode: 0o600 });
  buildCriticalManifest(releaseRoot, [
    "release.json",
    "node_modules/@earendil-works/pi-coding-agent/package.json",
    "node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
    "node_modules/@earendil-works/pi-coding-agent/dist/rpc-entry.js",
    "node_modules/@earendil-works/pi-coding-agent/npm-shrinkwrap.json",
  ], join(releaseRoot, "critical.sha256"));
  symlinkSync("releases/0.1.0-test", join(root, "current"));

  writeFileSync(oldNode, `#!/bin/sh\nexec '${recoveryCanonicalNode}' "$@"\n`, { mode: 0o700 });
  const oldBinding = await promoteRuntimeBinding({
    deploymentRoot: root,
    canonicalNodePath: realpathSync(oldNode),
    nodeVersion: "v26.7.0",
    qualifiedAt: "2026-09-01T00:00:00.000Z",
    source: "homebrew",
    qualificationGate: async () => true,
  });
  const nodePath = join(root, "node-current", "node");
  const launcherPath = join(runtimeExperimentRoot, "safe-rpc-launcher.mjs");
  const piWrapper = renderStablePiWrapper({ deploymentRoot: root, nodePath, nodeRecoveryPath, launcherPath });
  const launcherWrapper = renderStableLauncherWrapper({ deploymentRoot: root, nodePath, nodeRecoveryPath, launcherPath });
  writeFileSync(join(root, "pi"), piWrapper, { mode: 0o700 });
  writeFileSync(join(root, "pi-gondolin-rpc"), launcherWrapper, { mode: 0o700 });
  symlinkSync(join(root, "pi"), join(home, ".local", "bin", "pi"));
  symlinkSync(join(root, "pi-gondolin-rpc"), join(home, ".local", "bin", "pi-gondolin-rpc"));
  writeFileSync(join(root, "deployment.json"), `${JSON.stringify({
    version: 3,
    profile: "gondolin-rpc-transactional-releases",
    runtimeBindingVersion: 1,
    nodePath,
    nodeRecoveryPath,
    npmCommand: [nodePath, "/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js"],
    qemuPath: "/opt/homebrew/bin/qemu-system-aarch64",
    packageName: "@earendil-works/pi-coding-agent",
    currentRelease: "0.1.0-test",
    previousRelease: null,
    wrappers: {
      piSha256: sha256Text(piWrapper),
      launcherSha256: sha256Text(launcherWrapper),
    },
  }, null, 2)}\n`, { mode: 0o600 });

  return {
    root,
    home,
    oldKeg,
    oldBinding,
    recoveryCanonicalNode,
    releaseHashesBefore: hashTree(join(root, "releases")),
    recoveryEnvironment: () => buildRecoveryEnvironment({ deploymentRoot: root, home }),
    runPi: (args, extraEnvironment = {}) => spawnSync(join(home, ".local", "bin", "pi"), args, {
      encoding: "utf8",
      env: { ...process.env, HOME: home, ...extraEnvironment },
      timeout: 30_000,
    }),
    cleanup: temporary.cleanup,
  };
}

test("static deployment validation accepts a missing qualified runtime without executing it", () => {
  const fixture = staticDeploymentFixture();
  try {
    const status = deploymentStaticStatusV3({ home: fixture.home, deploymentRoot: fixture.root });
    assert.equal(status.staticIntegrityPassed, true);
    assert.equal(status.runtimeExecutable, false);
    assert.equal(fixture.executionCount(), 0);
  } finally {
    fixture.cleanup();
  }
});

test("adopts healthy and broken direct-path v3 deployments without changing releases", async (t) => {
  const cases = [
    ["healthy", realpathSync(process.execPath), process.version],
    ["broken", "/opt/homebrew/Cellar/node/0.0.0-missing/bin/node", "v0.0.0"],
  ];
  const projectRoot = fileURLToPath(new URL("..", import.meta.url));
  for (const [name, canonicalNodePath, nodeVersion] of cases) {
    await t.test(name, async () => {
      const fixture = staticDeploymentFixture({ canonicalNodePath, nodeVersion, runtimeBinding: false });
      const before = {
        current: readlinkSync(join(fixture.root, "current")),
        previous: readlinkSync(join(fixture.root, "previous")),
        releases: hashTree(join(fixture.root, "releases")),
      };
      try {
        const events = [];
        let activationCount = 0;
        const result = await adoptRuntimeBindingV3({
          home: fixture.home,
          projectRoot,
          deploymentRoot: fixture.root,
          qualificationGate: async (context) => {
            events.push(context);
            return true;
          },
          postActivationGate: async () => {
            activationCount += 1;
            return true;
          },
        });
        const state = JSON.parse(readFileSync(fixture.paths.statePath, "utf8"));
        assert.equal(events.length, 1);
        assert.equal(activationCount, 1);
        assert.equal(events[0].environment.OPENAI_API_KEY, undefined);
        assert.equal(state.runtimeBindingVersion, 1);
        assert.equal(state.nodePath, join(fixture.root, "node-current", "node"));
        assert.equal(result.staticIntegrityPassed, true);
        assert.equal(readlinkSync(join(fixture.root, "current")), before.current);
        assert.equal(readlinkSync(join(fixture.root, "previous")), before.previous);
        assert.equal(hashTree(join(fixture.root, "releases")), before.releases);
      } finally {
        fixture.cleanup();
      }
    });
  }
});

test("adoption interruption recovery completes every durable phase without changing releases", async (t) => {
  const projectRoot = fileURLToPath(new URL("..", import.meta.url));
  for (const phase of ["prepared", "artifacts-installed", "binding-active", "launchd-loaded"]) {
    await t.test(phase, async () => {
      const fixture = staticDeploymentFixture({ runtimeBinding: false });
      const releaseHashesBefore = hashTree(join(fixture.root, "releases"));
      const currentBefore = readlinkSync(join(fixture.root, "current"));
      const previousBefore = readlinkSync(join(fixture.root, "previous"));
      try {
        await assert.rejects(adoptRuntimeBindingV3({
          home: fixture.home,
          projectRoot,
          deploymentRoot: fixture.root,
          interruptionPoint: phase,
          qualificationGate: async () => true,
          postActivationGate: async () => true,
        }), /adoption-test-interruption/);

        const status = await installV3({
          home: fixture.home,
          projectRoot,
          deploymentRoot: fixture.root,
          qualificationGate: async () => true,
          postActivationGate: async () => true,
        });
        assert.equal(status.staticIntegrityPassed, true);
        assert.equal(readlinkSync(join(fixture.root, "current")), currentBefore);
        assert.equal(readlinkSync(join(fixture.root, "previous")), previousBefore);
        assert.equal(hashTree(join(fixture.root, "releases")), releaseHashesBefore);
        assert.equal(existsSync(join(fixture.root, "adoption")), false);
      } finally {
        fixture.cleanup();
      }
    });
  }
});

test("adoption interruption recovery starts from the journal when deployment state is between renames", async () => {
  const projectRoot = fileURLToPath(new URL("..", import.meta.url));
  const fixture = staticDeploymentFixture({ runtimeBinding: false });
  const releaseHashesBefore = hashTree(join(fixture.root, "releases"));
  try {
    await assert.rejects(adoptRuntimeBindingV3({
      home: fixture.home,
      projectRoot,
      deploymentRoot: fixture.root,
      interruptionPoint: "prepared",
      qualificationGate: async () => true,
      postActivationGate: async () => true,
    }), /adoption-test-interruption/);
    const backupRoot = join(fixture.root, "adoption", "backups");
    mkdirSync(backupRoot, { mode: 0o700 });
    const stateBackup = join(backupRoot, "deployment.json");
    const state = readFileSync(fixture.paths.statePath);
    writeFileSync(stateBackup, state, { mode: 0o600 });
    rmSync(fixture.paths.statePath);

    const status = await installV3({
      home: fixture.home,
      projectRoot,
      deploymentRoot: fixture.root,
      qualificationGate: async () => true,
      postActivationGate: async () => true,
    });
    assert.equal(status.staticIntegrityPassed, true);
    assert.equal(hashTree(join(fixture.root, "releases")), releaseHashesBefore);
  } finally {
    fixture.cleanup();
  }
});

test("adoption interruption recovery finishes a binding moved before node-current", async () => {
  const projectRoot = fileURLToPath(new URL("..", import.meta.url));
  const fixture = staticDeploymentFixture({ runtimeBinding: false });
  try {
    await assert.rejects(adoptRuntimeBindingV3({
      home: fixture.home,
      projectRoot,
      deploymentRoot: fixture.root,
      interruptionPoint: "artifacts-installed",
      qualificationGate: async () => true,
      postActivationGate: async () => true,
    }), /adoption-test-interruption/);
    const stagedBindingRoot = join(fixture.root, "adoption", "staged", "node-binding");
    const metadata = JSON.parse(readFileSync(join(stagedBindingRoot, "binding.json"), "utf8"));
    const bindingsRoot = join(fixture.root, "node-bindings");
    mkdirSync(bindingsRoot, { mode: 0o700 });
    chmodSync(stagedBindingRoot, 0o700);
    const finalBindingRoot = join(bindingsRoot, metadata.bindingId);
    renameSync(stagedBindingRoot, finalBindingRoot);
    chmodSync(finalBindingRoot, 0o500);

    const status = await installV3({
      home: fixture.home,
      projectRoot,
      deploymentRoot: fixture.root,
      qualificationGate: async () => true,
      postActivationGate: async () => true,
    });
    assert.equal(status.staticIntegrityPassed, true);
    assert.equal(inspectRuntimeBinding({ deploymentRoot: fixture.root, requireExecutable: true }).active, true);
  } finally {
    fixture.cleanup();
  }
});

test("fresh v3 runtime binding uses one stable deployment-owned Node path", async () => {
  const temporary = temporaryRoot("pi-fresh-v3-binding-");
  const deploymentRoot = join(temporary.root, "deployment");
  mkdirSync(deploymentRoot, { mode: 0o700 });
  let binding;
  try {
    const canonicalNodePath = realpathSync(process.execPath);
    binding = await promoteRuntimeBinding({
      deploymentRoot,
      canonicalNodePath,
      nodeVersion: process.version,
      qualifiedAt: "2026-09-09T00:00:00.000Z",
      source: "install",
      qualificationGate: async () => true,
    });
    const npmPath = "/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js";
    const state = buildDeploymentRuntimeState({ deploymentRoot, canonicalNodePath, npmPath });
    const expectedNodePath = join(deploymentRoot, "node-current", "node");

    assert.deepEqual(state, {
      version: 3,
      runtimeBindingVersion: 1,
      nodePath: expectedNodePath,
      nodeRecoveryPath: homebrewRecoveryAnchor(canonicalNodePath),
      npmCommand: [expectedNodePath, npmPath],
    });
    assert.equal(
      inspectRuntimeBinding({ deploymentRoot, requireExecutable: true }).canonicalNodePath,
      canonicalNodePath,
    );
    const wrapper = renderStablePiWrapper({
      deploymentRoot,
      nodePath: state.nodePath,
      nodeRecoveryPath: state.nodeRecoveryPath,
      launcherPath: join(deploymentRoot, "controller", "runtime", "safe-rpc-launcher.mjs"),
    });
    assert.match(wrapper, new RegExp(expectedNodePath.replaceAll("/", "\\/")));
    assert.match(wrapper, new RegExp(state.nodeRecoveryPath.replaceAll("/", "\\/")));
  } finally {
    if (binding) chmodSync(binding.bindingRoot, 0o700);
    temporary.cleanup();
  }
});

test("static deployment validation fails closed for every critical integrity class", async (t) => {
  const mutations = [
    ["controller manifest", ({ controllerPath }) => writeFileSync(controllerPath, "tampered\n")],
    ["runtime manifest", ({ runtimePath }) => writeFileSync(runtimePath, "tampered\n")],
    ["release manifest", ({ releaseMetadata }) => writeFileSync(releaseMetadata, "{}\n")],
    ["wrapper hash", ({ piWrapper }) => writeFileSync(piWrapper, "#!/bin/sh\nexit 0\n")],
    ["binding manifest", ({ bindingManifest }) => {
      chmodSync(bindingManifest, 0o600);
      writeFileSync(bindingManifest, "invalid\n");
    }],
    ["installed link", ({ installedPi }) => {
      rmSync(installedPi);
      symlinkSync("/missing/pi", installedPi);
    }],
    ["current release link", ({ current }) => {
      rmSync(current);
      symlinkSync("releases/missing", current);
    }],
    ["deployment state", ({ statePath }) => writeFileSync(statePath, "{}\n", { mode: 0o600 })],
  ];
  for (const [name, mutate] of mutations) {
    await t.test(name, () => {
      const fixture = staticDeploymentFixture();
      try {
        mutate(fixture.paths);
        const status = deploymentStaticStatusV3({ home: fixture.home, deploymentRoot: fixture.root });
        assert.equal(status.staticIntegrityPassed, false);
        assert.equal(fixture.executionCount(), 0);
      } finally {
        fixture.cleanup();
      }
    });
  }
});

test("runtime repin qualifies the current release before switching the binding", async () => {
  const fixture = staticDeploymentFixture();
  try {
    const events = [];
    const recoveryCanonicalNode = realpathSync(process.execPath);
    const result = await runtimeRepinV3({
      home: fixture.home,
      deploymentRoot: fixture.root,
      qualificationGate: async ({ candidateNodePath, releaseRoot, environment }) => {
        events.push({ candidateNodePath, releaseRoot, environment });
        return true;
      },
    });

    assert.equal(events.length, 1);
    assert.equal(events[0].candidateNodePath, recoveryCanonicalNode);
    assert.equal(events[0].environment.HOME, fixture.home);
    assert.equal(events[0].environment.OPENAI_API_KEY, undefined);
    assert.equal(events[0].environment.ANTHROPIC_API_KEY, undefined);
    assert.equal(result.canonicalNodePath, recoveryCanonicalNode);
    assert.equal(inspectRuntimeBinding({ deploymentRoot: fixture.root, requireExecutable: true }).active, true);
  } finally {
    fixture.cleanup();
  }
});

test("runtime repin preserves node-current on every refusal", async (t) => {
  const cases = [
    ["static integrity failure", async (fixture) => {
      writeFileSync(fixture.paths.controllerPath, "tampered\n");
      await assert.rejects(runtimeRepinV3({
        home: fixture.home,
        deploymentRoot: fixture.root,
        qualificationGate: async () => true,
      }), /deployment-pre-repin-invalid/);
    }],
    ["qualification failure", async (fixture) => {
      await assert.rejects(runtimeRepinV3({
        home: fixture.home,
        deploymentRoot: fixture.root,
        qualificationGate: async () => false,
      }), /node-runtime-qualification-refused/);
    }],
    ["recovery mismatch", async (fixture) => {
      const state = JSON.parse(readFileSync(fixture.paths.statePath, "utf8"));
      state.nodeRecoveryPath = "/usr/local/opt/node/bin/node";
      writeFileSync(fixture.paths.statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      await assert.rejects(runtimeRepinV3({
        home: fixture.home,
        deploymentRoot: fixture.root,
        qualificationGate: async () => true,
      }), /deployment-pre-repin-invalid|node-runtime-recovery-mismatch/);
    }],
    ["update lock held", async (fixture) => {
      const releaseLock = acquireUpdateLock(fixture.root);
      try {
        await assert.rejects(runtimeRepinV3({
          home: fixture.home,
          deploymentRoot: fixture.root,
          qualificationGate: async () => true,
        }), /update-lock-active/);
      } finally {
        releaseLock();
      }
    }],
  ];

  for (const [name, refuse] of cases) {
    await t.test(name, async () => {
      const fixture = staticDeploymentFixture();
      const originalTarget = readlinkSync(join(fixture.root, "node-current"));
      try {
        await refuse(fixture);
        assert.equal(readlinkSync(join(fixture.root, "node-current")), originalTarget);
      } finally {
        fixture.cleanup();
      }
    });
  }
});

test("runtime repin refuses to replace a healthy active binding", async () => {
  const fixture = staticDeploymentFixture({
    canonicalNodePath: realpathSync(process.execPath),
    nodeVersion: process.version,
  });
  const originalTarget = readlinkSync(join(fixture.root, "node-current"));
  try {
    await assert.rejects(runtimeRepinV3({
      home: fixture.home,
      deploymentRoot: fixture.root,
      qualificationGate: async () => true,
    }), /node-runtime-still-healthy/);
    assert.equal(readlinkSync(join(fixture.root, "node-current")), originalTarget);
  } finally {
    fixture.cleanup();
  }
});

test("runtime repin refuses a Node executable outside an accepted Homebrew keg", () => {
  const fixture = staticDeploymentFixture();
  const copiedKeg = join(dirname(fixture.root), "untrusted-keg");
  const copiedNode = join(copiedKeg, "bin", "node");
  const controllerUrl = new URL("../experiments/gondolin/deployment-controller.mjs", import.meta.url).href;
  const originalTarget = readlinkSync(join(fixture.root, "node-current"));
  try {
    const sourceKeg = dirname(dirname(realpathSync(process.execPath)));
    const libnodeName = readdirSync(join(sourceKeg, "lib")).find((name) => /^libnode\..+\.dylib$/.test(name));
    assert.notEqual(libnodeName, undefined);
    mkdirSync(join(copiedKeg, "bin"), { recursive: true, mode: 0o700 });
    mkdirSync(join(copiedKeg, "lib"), { recursive: true, mode: 0o700 });
    cpSync(process.execPath, copiedNode);
    cpSync(join(sourceKeg, "lib", libnodeName), join(copiedKeg, "lib", libnodeName));
    chmodSync(copiedNode, 0o700);
    const script = `
      import { runtimeRepinV3 } from ${JSON.stringify(controllerUrl)};
      try {
        await runtimeRepinV3(${JSON.stringify({ home: fixture.home, deploymentRoot: fixture.root })});
        process.stdout.write("unexpected-success");
      } catch (error) {
        process.stdout.write(error instanceof Error ? error.message : "unknown");
      }
    `;
    const result = spawnSync(copiedNode, ["--input-type=module", "--eval", script], {
      encoding: "utf8",
      env: { HOME: fixture.home, PATH: "/usr/bin:/bin" },
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "node-runtime-recovery-mismatch");
    assert.equal(readlinkSync(join(fixture.root, "node-current")), originalTarget);
  } finally {
    fixture.cleanup();
  }
});

test("runtime repin CLI accepts no executable argument and reports only stable refusal data", () => {
  const fixture = staticDeploymentFixture();
  const scriptPath = fileURLToPath(new URL("../experiments/gondolin/update-local.mjs", import.meta.url));
  const originalTarget = readlinkSync(join(fixture.root, "node-current"));
  const environment = {
    HOME: fixture.home,
    PATH: "/usr/bin:/bin",
    PI_GONDOLIN_DEPLOYMENT_ROOT: fixture.root,
    OPENAI_API_KEY: "must-not-appear",
  };
  try {
    const refusedQualification = spawnSync(process.execPath, [scriptPath, "runtime-repin"], {
      encoding: "utf8",
      env: environment,
      timeout: 10_000,
    });
    assert.equal(refusedQualification.status, 1);
    assert.equal(refusedQualification.stdout, "");
    assert.equal(
      refusedQualification.stderr,
      "gondolin-transactional-update-refused:node-runtime-qualification-refused\n",
    );
    assert.doesNotMatch(refusedQualification.stderr, /must-not-appear|\/Users\//);
    assert.equal(readlinkSync(join(fixture.root, "node-current")), originalTarget);

    const refusedArgument = spawnSync(process.execPath, [scriptPath, "runtime-repin", process.execPath], {
      encoding: "utf8",
      env: environment,
      timeout: 10_000,
    });
    assert.equal(refusedArgument.status, 1);
    assert.equal(refusedArgument.stdout, "");
    assert.equal(refusedArgument.stderr, "gondolin-transactional-update-refused:usage-invalid\n");
    assert.equal(readlinkSync(join(fixture.root, "node-current")), originalTarget);
  } finally {
    fixture.cleanup();
  }
});

test("recovers after Homebrew removes the exact Node keg without changing Pi", async () => {
  const fixture = await runtimeLifecycleFixture();
  const removedKeg = `${fixture.oldKeg}.removed`;
  try {
    const before = fixture.runPi(["--version"]);
    assert.equal(before.status, 0, before.stderr);
    assert.equal(before.stdout.trim(), "0.1.0");

    renameSync(fixture.oldKeg, removedKeg);
    const recovered = fixture.runPi(["--version"], {
      OPENAI_API_KEY: "must-not-cross-recovery",
      PWD: "/private/project-path",
    });
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(recovered.stdout.trim(), "0.1.0");
    assert.equal(fixture.recoveryEnvironment().OPENAI_API_KEY, undefined);
    assert.equal(fixture.recoveryEnvironment().PWD, undefined);

    const active = inspectRuntimeBinding({ deploymentRoot: fixture.root, requireExecutable: true });
    assert.equal(active.canonicalNodePath, fixture.recoveryCanonicalNode);
    assert.equal(active.nodeVersion, process.version);
    assert.equal(hashTree(join(fixture.root, "releases")), fixture.releaseHashesBefore);
    assert.equal(existsSync(fixture.oldBinding.bindingRoot), true);

    const auditText = readdirSync(join(fixture.root, "node-bindings"))
      .map((bindingId) => readFileSync(join(fixture.root, "node-bindings", bindingId, "binding.json"), "utf8"))
      .join("\n");
    assert.doesNotMatch(auditText, /must-not-cross-recovery|private\/project-path|--version/);
    assert.doesNotMatch(auditText, new RegExp(fixture.home.replaceAll("/", "\\/")));
  } finally {
    if (existsSync(removedKeg)) renameSync(removedKeg, fixture.oldKeg);
    fixture.cleanup();
  }
});

test("les cibles update séparant Pi des catalogues et extensions sont explicites", () => {
  const selfCases = [
    ["update"],
    ["update", "pi"],
    ["update", "self"],
    ["update", "--self"],
    ["update", "--self", "--force"],
    ["update", "--all"],
  ];
  for (const args of selfCases) {
    assert.equal(classifyUpdateRequest(args).kind, "self", args.join(" "));
  }
  assert.deepEqual(classifyUpdateRequest(["update", "--all"]), {
    kind: "self",
    force: false,
    updateExtensions: true,
  });
  assert.deepEqual(classifyUpdateRequest(["update", "--self", "--force"]), {
    kind: "self",
    force: true,
    updateExtensions: false,
  });

  const delegatedCases = [
    ["update", "--models"],
    ["update", "--extensions"],
    ["update", "--extension", "npm:example"],
    ["update", "npm:example"],
  ];
  for (const args of delegatedCases) {
    assert.deepEqual(classifyUpdateRequest(args), { kind: "delegate" }, args.join(" "));
  }
  assert.deepEqual(classifyUpdateRequest(["update", "--unknown"]), { kind: "refuse" });
  assert.deepEqual(classifyUpdateRequest(["update", "--self", "--models"]), { kind: "refuse" });
  assert.deepEqual(classifyUpdateRequest(["--version"]), { kind: "execute" });
});

test("la release distante exige le package autorisé, une version exacte et une intégrité npm", () => {
  const release = parseLatestRelease(
    { ok: true, version: "0.82.1", packageName: "@earendil-works/pi-coding-agent" },
    "sha512-test-integrity",
  );
  assert.deepEqual(release, {
    packageName: "@earendil-works/pi-coding-agent",
    version: "0.82.1",
    integrity: "sha512-test-integrity",
  });
  assert.match(releaseIdFor(release), /^0\.82\.1-[a-f0-9]{12}$/);

  assert.throws(
    () => parseLatestRelease({ ok: true, version: "0.82.1", packageName: "attacker" }, "sha512-test"),
    /release-package-refused/,
  );
  assert.throws(
    () => parseLatestRelease({ ok: true, version: "latest", packageName: "@earendil-works\/pi-coding-agent" }, "sha512-test"),
    /release-version-invalid/,
  );
  assert.throws(
    () => parseLatestRelease({ ok: true, version: "0.82.1", packageName: "@earendil-works/pi-coding-agent" }, ""),
    /release-integrity-invalid/,
  );
  assert.equal(compareVersions("0.82.1", "0.80.10"), 1);
  assert.equal(compareVersions("0.82.1", "0.82.1"), 0);
  assert.equal(compareVersions("0.80.10", "0.82.1"), -1);
  assert.equal(compareVersions("1.0.0", "0.99.99"), 1);
  assert.equal(compareVersions("0.83.0-beta.10", "0.83.0-beta.2"), 1);
  assert.equal(compareVersions("0.83.0-beta.1", "0.83.0-beta.alpha"), -1);
  assert.equal(compareVersions("0.83.0-beta.1", "0.83.0-beta.1.0"), -1);
});

test("la candidate installée doit correspondre exactement à la version et à l’intégrité npm", () => {
  const { root, cleanup } = temporaryRoot("pi-updater-package-");
  try {
    const packageRoot = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
    mkdirSync(join(packageRoot, "dist"), { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), `${JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      version: "0.82.1",
      bin: { pi: "dist/cli.js" },
    })}\n`);
    writeFileSync(join(packageRoot, "dist", "cli.js"), "cli\n");
    writeFileSync(join(packageRoot, "dist", "rpc-entry.js"), "rpc\n");
    writeFileSync(join(packageRoot, "npm-shrinkwrap.json"), `${JSON.stringify({
      packages: {
        "": { license: "MIT" },
        "node_modules/permissive": { version: "1.0.0", license: "BlueOak-1.0.0" },
      },
    })}\n`);
    writeFileSync(join(root, "package-lock.json"), `${JSON.stringify({
      packages: {
        "node_modules/@earendil-works/pi-coding-agent": {
          version: "0.82.1",
          integrity: "sha512-test-integrity",
        },
      },
    })}\n`);

    const release = {
      packageName: "@earendil-works/pi-coding-agent",
      version: "0.82.1",
      integrity: "sha512-test-integrity",
    };
    assert.equal(verifyCandidatePackage(root, release), packageRoot);
    assert.deepEqual(auditPiPackageLicenses(packageRoot), {
      packageCount: 2,
      licenses: { "BlueOak-1.0.0": 1, MIT: 1 },
      passes: true,
    });
    assert.throws(
      () => verifyCandidatePackage(root, { ...release, integrity: "sha512-other" }),
      /candidate-integrity-mismatch/,
    );
  } finally {
    cleanup();
  }
});

test("le job launchd appelle uniquement le contrôleur déployé avec des sorties neutralisées", () => {
  const plist = renderLaunchAgentPlist({
    home: "/Users/test&user",
    deploymentRoot: "/Users/test&user/.local/share/pi<guard>",
    piWrapperPath: "/Users/test&user/.local/share/pi<guard>/pi",
  });
  assert.match(plist, /dev\.pi-gondolin\.transactional-update/);
  assert.match(plist, /pi&lt;guard&gt;\/pi/);
  assert.doesNotMatch(plist, /\/opt\/node\/bin\/node/);
  assert.doesNotMatch(plist, /update-local\.mjs/);
  assert.match(plist, /<string>update<\/string>/);
  assert.match(plist, /\/dev\/null/);
  assert.match(plist, /test&amp;user/);
  assert.match(plist, /pi&lt;guard&gt;/);
  assert.doesNotMatch(plist, /StandardOutPath>[\s\S]*\.log/);
});

test("les wrappers stables réparent seulement un binding Node cassé", () => {
  const deploymentRoot = "/Users/test/deployment";
  const nodePath = `${deploymentRoot}/node-current/node`;
  const nodeRecoveryPath = "/opt/homebrew/opt/node/bin/node";
  const launcherPath = `${deploymentRoot}/controller/runtime/experiments/gondolin/safe-rpc-launcher.mjs`;
  const piWrapper = renderStablePiWrapper({
    deploymentRoot,
    nodePath,
    nodeRecoveryPath,
    launcherPath,
  });
  const launcherWrapper = renderStableLauncherWrapper({
    deploymentRoot,
    nodePath,
    nodeRecoveryPath,
    launcherPath,
  });

  for (const wrapper of [piWrapper, launcherWrapper]) {
    assert.match(wrapper, /NODE='\/Users\/test\/deployment\/node-current\/node'/);
    assert.match(wrapper, /RECOVERY_NODE='\/opt\/homebrew\/opt\/node\/bin\/node'/);
    assert.match(wrapper, /if \[ ! -x "\$NODE" \]; then/);
    assert.match(wrapper, /\/usr\/bin\/env -i/);
    assert.match(wrapper, /runtime-repin/);
    assert.doesNotMatch(wrapper, /Cellar\/node/);
    assert.doesNotMatch(wrapper, /OPENAI_API_KEY|ANTHROPIC_API_KEY/);
  }
  assert.equal((piWrapper.match(/controller\.sha256/g) ?? []).length, 1);
  assert.equal((launcherWrapper.match(/controller\.sha256/g) ?? []).length, 1);
});

test("launchd réutilise le wrapper Pi stable sans pinner Node", () => {
  const plist = renderLaunchAgentPlist({
    home: "/Users/test&user",
    deploymentRoot: "/Users/test&user/.local/share/pi<guard>",
    piWrapperPath: "/Users/test&user/.local/share/pi<guard>/pi",
  });

  assert.match(plist, /<string>\/Users\/test&amp;user\/\.local\/share\/pi&lt;guard&gt;\/pi<\/string>/);
  assert.match(plist, /<string>update<\/string>/);
  assert.doesNotMatch(plist, /Cellar\/node|opt\/node\/bin\/node|update-local\.mjs/);
  assert.doesNotMatch(plist, /StandardOutPath>[\s\S]*\.log/);
});

test("l’audit des dépendances Pi refuse les licences interdites ou inconnues", () => {
  const { root, cleanup } = temporaryRoot("pi-updater-license-");
  try {
    writeFileSync(join(root, "npm-shrinkwrap.json"), `${JSON.stringify({
      packages: {
        "": { license: "MIT" },
        "node_modules/forbidden": { version: "1.0.0", license: "AGPL-3.0" },
      },
    })}\n`);
    assert.throws(() => auditPiPackageLicenses(root), /candidate-license-refused/);
  } finally {
    cleanup();
  }
});

test("le verrou update est privé, exclusif et refuse les symlinks", () => {
  const { root, cleanup } = temporaryRoot("pi-updater-lock-");
  try {
    const release = acquireUpdateLock(root);
    assert.throws(() => acquireUpdateLock(root), /update-lock-active/);
    release();
    const secondRelease = acquireUpdateLock(root);
    secondRelease();

    const target = join(root, "lock-target");
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, join(root, "update.lock"));
    assert.throws(() => acquireUpdateLock(root), /update-lock-unsafe/);
  } finally {
    cleanup();
  }
});

test("le manifeste critique refuse les chemins hors release, les symlinks et la dérive", () => {
  const { root, cleanup } = temporaryRoot("pi-updater-manifest-");
  try {
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist", "cli.js"), "cli\n");
    writeFileSync(join(root, "package.json"), "{}\n");
    const manifestPath = join(root, "critical.sha256");
    buildCriticalManifest(root, ["dist/cli.js", "package.json"], manifestPath);
    assert.equal(verifyCriticalManifest(root, manifestPath), true);
    assert.match(readFileSync(manifestPath, "utf8"), /dist\/cli\.js/);

    writeFileSync(join(root, "dist", "cli.js"), "tampered\n");
    assert.equal(verifyCriticalManifest(root, manifestPath), false);
    assert.throws(() => buildCriticalManifest(root, ["../outside"], manifestPath), /manifest-path-invalid/);

    writeFileSync(join(root, "real"), "value\n");
    symlinkSync(join(root, "real"), join(root, "linked"));
    assert.throws(() => buildCriticalManifest(root, ["linked"], manifestPath), /manifest-file-unsafe/);
  } finally {
    cleanup();
  }
});

test("une candidate qualifiée est activée atomiquement et conserve la précédente", async () => {
  const { root, cleanup } = temporaryRoot("pi-updater-promote-");
  try {
    const releases = join(root, "releases");
    const candidates = join(root, "candidates");
    const baseline = join(releases, "0.80.10-baseline");
    const candidate = join(candidates, "candidate-new");
    mkdirSync(baseline, { recursive: true, mode: 0o700 });
    mkdirSync(candidate, { recursive: true, mode: 0o700 });
    symlinkSync("releases/0.80.10-baseline", join(root, "current"));

    const result = await promoteCandidate({
      deploymentRoot: root,
      candidatePath: candidate,
      releaseId: "0.82.1-qualified",
      qualificationGates: [{ name: "compatibility", run: async () => true }],
      postActivationGate: async () => true,
    });

    assert.deepEqual(result, {
      activated: true,
      releaseId: "0.82.1-qualified",
      gates: ["compatibility"],
    });
    assert.equal(resolvedLink(join(root, "current")), "releases/0.82.1-qualified");
    assert.equal(resolvedLink(join(root, "previous")), "releases/0.80.10-baseline");
  } finally {
    cleanup();
  }
});

test("un gate candidate en échec ne modifie aucun lien actif", async () => {
  const { root, cleanup } = temporaryRoot("pi-updater-refuse-");
  try {
    const baseline = join(root, "releases", "baseline");
    const candidate = join(root, "candidates", "candidate-bad");
    mkdirSync(baseline, { recursive: true, mode: 0o700 });
    mkdirSync(candidate, { recursive: true, mode: 0o700 });
    symlinkSync("releases/baseline", join(root, "current"));

    await assert.rejects(
      promoteCandidate({
        deploymentRoot: root,
        candidatePath: candidate,
        releaseId: "candidate-bad",
        qualificationGates: [{ name: "rpc-boundary", run: async () => false }],
        postActivationGate: async () => true,
      }),
      /qualification-gate-refused:rpc-boundary/,
    );
    assert.equal(resolvedLink(join(root, "current")), "releases/baseline");
    assert.throws(() => readlinkSync(join(root, "previous")), /ENOENT/);
  } finally {
    cleanup();
  }
});

test("le rollback de release échange current et previous sans supprimer de preuve", () => {
  const { root, cleanup } = temporaryRoot("pi-updater-rollback-");
  try {
    mkdirSync(join(root, "releases", "current"), { recursive: true });
    mkdirSync(join(root, "releases", "previous"), { recursive: true });
    symlinkSync("releases/current", join(root, "current"));
    symlinkSync("releases/previous", join(root, "previous"));
    assert.deepEqual(rollbackRelease(root), {
      rolledBack: true,
      current: "previous",
      previous: "current",
    });
    assert.equal(resolvedLink(join(root, "current")), "releases/previous");
    assert.equal(resolvedLink(join(root, "previous")), "releases/current");
  } finally {
    cleanup();
  }
});

test("un smoke post-activation en échec restaure exactement current et previous", async () => {
  const { root, cleanup } = temporaryRoot("pi-updater-post-smoke-");
  try {
    const baseline = join(root, "releases", "baseline");
    const older = join(root, "releases", "older");
    const candidate = join(root, "candidates", "candidate-post-fail");
    mkdirSync(baseline, { recursive: true, mode: 0o700 });
    mkdirSync(older, { recursive: true, mode: 0o700 });
    mkdirSync(candidate, { recursive: true, mode: 0o700 });
    symlinkSync("releases/baseline", join(root, "current"));
    symlinkSync("releases/older", join(root, "previous"));

    await assert.rejects(
      promoteCandidate({
        deploymentRoot: root,
        candidatePath: candidate,
        releaseId: "candidate-post-fail",
        qualificationGates: [{ name: "candidate", run: async () => true }],
        postActivationGate: async () => false,
      }),
      /post-activation-gate-refused/,
    );
    assert.equal(resolvedLink(join(root, "current")), "releases/baseline");
    assert.equal(resolvedLink(join(root, "previous")), "releases/older");
    assert.equal(lstatSync(candidate).isDirectory(), true);
  } finally {
    cleanup();
  }
});
