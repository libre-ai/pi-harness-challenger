# Transactional Node Runtime Repin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Pi bound to an exact qualified Homebrew Node runtime while automatically and atomically recovering when Homebrew removes the active keg.

**Architecture:** Add immutable runtime-binding generations selected by one `node-current` symlink. Keep recovery inline in the two stable wrappers, execute it with a secret-free environment, qualify the current Pi release before switching the binding, and make one-time v3 controller adoption recoverable through a private phase journal.

**Tech Stack:** Node.js ESM, `node:test`, POSIX shell templates, macOS `launchd`, filesystem manifests, existing Gondolin qualification gates.

**Spec:** `docs/superpowers/specs/2026-09-09-transactional-node-runtime-repin-design.md`

## Global Constraints

- Security decisions precede quality, performance, and completeness decisions.
- Keep `deployment.json.version` at `3`; add `runtimeBindingVersion: 1` and `nodeRecoveryPath` explicitly.
- Accept only canonical Apple Silicon or Intel Homebrew Node keg paths; never select recovery through `PATH`.
- Treat Homebrew as the Node provenance authority and the Gondolin gates as compatibility qualification only.
- Never expose provider credentials, caller environment, project paths, prompts, commands, secrets, or PII to recovery or persist them in binding metadata.
- Do not add a runtime dispatcher or another healthy-path shell/Node process.
- Do not fetch or promote a Pi release during `runtime-repin`.
- Do not modify `current`, `previous`, or any qualified Pi release during v3 adoption.
- Add no external dependency.
- Keep Pi 0.85.1 CLI layout and QEMU lifecycle changes out of scope.
- Every production behavior begins with a failing test and ends with focused plus full verification.

## File Map

- Create `experiments/gondolin/runtime-binding.mjs`: Homebrew path policy, immutable binding creation/verification, atomic activation, and minimal recovery environment.
- Create `test/runtime-binding.test.mjs`: focused unit and filesystem tests for runtime bindings.
- Create `experiments/gondolin/runtime-adoption.mjs`: private journal validation, durable phases, fixed-name backup restoration, and interruption recovery.
- Create `test/runtime-adoption.test.mjs`: focused journal and crash-recovery tests.
- Modify `experiments/gondolin/deployment-controller.mjs`: wrapper rendering, static deployment validation, repin orchestration, fresh install wiring, and recoverable v3 adoption.
- Modify `experiments/gondolin/update-local.mjs`: expose the administrative `runtime-repin` route without accepting an arbitrary executable path.
- Modify `test/transactional-updater.test.mjs`: wrapper, launchd, repin orchestration, adoption, rollback, and original-regression tests.
- Modify `package.json`: add blocking coverage for the new runtime-binding module.
- Modify `docs/adr-0001-transactional-pi-updates.md`: record the runtime-binding and Homebrew trust decisions.
- Modify `experiments/gondolin/README.md`: document recovery, explicit administration, refusals, and v3 adoption.

---

### Task 1: Immutable runtime-binding domain

**Files:**
- Create: `experiments/gondolin/runtime-binding.mjs`
- Create: `test/runtime-binding.test.mjs`

**Interfaces:**
- Produces: `RUNTIME_BINDING_VERSION = 1`
- Produces: `homebrewRecoveryAnchor(canonicalNodePath: string) -> string`
- Produces: `buildRecoveryEnvironment({ deploymentRoot, home }: object) -> object`
- Produces: `inspectRuntimeBinding({ deploymentRoot, requireExecutable }: object) -> RuntimeBinding`
- Produces: `promoteRuntimeBinding({ deploymentRoot, canonicalNodePath, nodeVersion, qualifiedAt, source, qualificationGate }: object) -> Promise<RuntimeBinding>`
- `RuntimeBinding` contains `bindingId`, `bindingRoot`, `canonicalNodePath`, `nodePath`, `nodeVersion`, `qualifiedAt`, `recoverySource`, and `active`.

- [ ] **Step 1: Write failing Homebrew-policy and environment tests**

Add tests that define the accepted path policy and prove caller secrets are removed:

```js
import {
  buildRecoveryEnvironment,
  homebrewRecoveryAnchor,
} from "../experiments/gondolin/runtime-binding.mjs";

test("Homebrew recovery anchors are derived only from canonical Node kegs", () => {
  assert.equal(
    homebrewRecoveryAnchor("/opt/homebrew/Cellar/node/26.8.1/bin/node"),
    "/opt/homebrew/opt/node/bin/node",
  );
  assert.equal(
    homebrewRecoveryAnchor("/usr/local/Cellar/node/24.7.0_1/bin/node"),
    "/usr/local/opt/node/bin/node",
  );
  for (const path of [
    "/opt/homebrew/bin/node",
    "/tmp/Cellar/node/26.8.1/bin/node",
    "/opt/homebrew/Cellar/node/../../bin/node",
    "/opt/homebrew/Cellar/node/26.8.1/bin/node\nother",
  ]) {
    assert.throws(() => homebrewRecoveryAnchor(path), /node-runtime-layout-unsupported/);
  }
});

test("the recovery environment excludes caller secrets and project state", () => {
  const environment = buildRecoveryEnvironment({
    deploymentRoot: "/Users/test/.local/share/pi-harness-challenger/gondolin-rpc/v3",
    home: "/Users/test",
  });
  assert.deepEqual(environment, {
    HOME: "/Users/test",
    PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    PI_GONDOLIN_DEPLOYMENT_ROOT: "/Users/test/.local/share/pi-harness-challenger/gondolin-rpc/v3",
    TMPDIR: "/Users/test/.local/share/pi-harness-challenger/gondolin-rpc/v3/tmp",
  });
  assert.equal(environment.ANTHROPIC_API_KEY, undefined);
  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.PWD, undefined);
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `node --test test/runtime-binding.test.mjs`

Expected: FAIL because `runtime-binding.mjs` and its exports do not exist.

- [ ] **Step 3: Implement the path policy and minimal environment**

Create `runtime-binding.mjs` with strict string validation and no `process.env` spread:

```js
const HOMEBREW_NODE_PATTERN = /^(\/opt\/homebrew|\/usr\/local)\/Cellar\/node\/([0-9A-Za-z][0-9A-Za-z._+-]*)\/bin\/node$/;

export const RUNTIME_BINDING_VERSION = 1;

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
  return {
    HOME: home,
    PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    PI_GONDOLIN_DEPLOYMENT_ROOT: deploymentRoot,
    TMPDIR: `${deploymentRoot}/tmp`,
  };
}
```

Validate `deploymentRoot` and `home` as absolute, newline-free, NUL-free paths before returning the environment. Create the private recovery temp directory in the caller, not in this pure builder.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `node --test test/runtime-binding.test.mjs`

Expected: all path-policy and environment tests PASS.

- [ ] **Step 5: Write failing immutable-binding promotion tests**

Use a temporary deployment and executable fixture. Assert real filesystem behavior, not mocked calls:

```js
test("a qualified runtime binding is immutable and activated atomically", async () => {
  const { root, cleanup } = temporaryRoot("pi-runtime-binding-");
  try {
    const node = join(root, "fixtures", "node-26.8.1");
    mkdirSync(dirname(node), { recursive: true });
    writeFileSync(node, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const seen = [];
    const binding = await promoteRuntimeBinding({
      deploymentRoot: root,
      canonicalNodePath: node,
      nodeVersion: "v26.8.1",
      qualifiedAt: "2026-09-09T12:00:00.000Z",
      source: "homebrew",
      qualificationGate: async (candidate) => {
        seen.push(candidate);
        return true;
      },
    });

    assert.deepEqual(seen, [node]);
    assert.equal(readlinkSync(join(root, "node-current")), `node-bindings/${binding.bindingId}`);
    assert.equal(readlinkSync(join(binding.bindingRoot, "node")), node);
    assert.equal(binding.active, true);
    assert.equal(inspectRuntimeBinding({ deploymentRoot: root, requireExecutable: true }).bindingId, binding.bindingId);
    assert.equal(lstatSync(binding.bindingRoot).mode & 0o077, 0);
  } finally {
    cleanup();
  }
});

test("a failed qualification never changes the active runtime", async () => {
  const fixture = await deploymentWithActiveRuntime("v26.7.0");
  try {
    const before = readlinkSync(join(fixture.root, "node-current"));
    await assert.rejects(
      promoteRuntimeBinding({
        deploymentRoot: fixture.root,
        canonicalNodePath: fixture.nextNode,
        nodeVersion: "v26.8.1",
        qualifiedAt: "2026-09-09T12:00:00.000Z",
        source: "homebrew",
        qualificationGate: async () => false,
      }),
      /node-runtime-qualification-refused/,
    );
    assert.equal(readlinkSync(join(fixture.root, "node-current")), before);
  } finally {
    fixture.cleanup();
  }
});
```

Also assert refusal of symlinked binding directories, non-owned or group/other-writable metadata, malformed manifests, unexpected target text, and a non-executable active target when `requireExecutable` is true.

- [ ] **Step 6: Run the binding tests and verify RED**

Run: `node --test test/runtime-binding.test.mjs`

Expected: FAIL because binding promotion and inspection are not implemented.

- [ ] **Step 7: Implement immutable generation creation and atomic activation**

Use existing project patterns: private directories, `flag: "wx"`, temporary names containing `randomUUID()`, and `renameSync` for final activation. The sequence must be:

```js
const candidateRoot = join(bindingsRoot, `.candidate-${process.pid}-${randomUUID()}`);
writeBinding(candidateRoot, metadata, canonicalNodePath);
verifyBinding(candidateRoot, { requireExecutable: true });
if (!await qualificationGate(canonicalNodePath)) {
  rmSync(candidateRoot, { recursive: true });
  throw new Error("node-runtime-qualification-refused");
}
renameSync(candidateRoot, finalBindingRoot);
atomicSymlink(`node-bindings/${bindingId}`, join(deploymentRoot, "node-current"));
```

Wrap binding creation and qualification so a thrown gate also removes only the current unqualified candidate before rethrowing. Compute `bindingId` from the normalized Node version plus the first 12 hexadecimal characters of SHA-256 over the canonical path and version. Hash the exact private `binding.json` bytes in `binding.sha256`; verify that `binding.json.canonicalNodePath` equals the `node` symlink target. Retain previously qualified generations.

- [ ] **Step 8: Run focused tests and coverage**

Run: `node --test test/runtime-binding.test.mjs`

Run: `node --test --experimental-test-coverage --test-coverage-include=experiments/gondolin/runtime-binding.mjs --test-coverage-lines=95 --test-coverage-branches=90 --test-coverage-functions=100 test/runtime-binding.test.mjs`

Expected: all tests PASS and every threshold is met with zero warnings.

- [ ] **Step 9: Commit the runtime-binding domain**

```bash
git add experiments/gondolin/runtime-binding.mjs test/runtime-binding.test.mjs
git commit -m "feat(runtime): add immutable qualified Node bindings"
```

---

### Task 2: Stable wrappers and launchd recovery route

**Files:**
- Modify: `experiments/gondolin/deployment-controller.mjs:281-427`
- Modify: `test/transactional-updater.test.mjs:145-180`

**Interfaces:**
- Consumes: `homebrewRecoveryAnchor()` and binding layout from Task 1.
- Produces: exported `renderStablePiWrapper({ deploymentRoot, nodePath, nodeRecoveryPath, launcherPath }) -> string`
- Produces: exported `renderStableLauncherWrapper({ deploymentRoot, nodePath, nodeRecoveryPath, launcherPath }) -> string`
- Changes: `renderLaunchAgentPlist({ home, deploymentRoot, piWrapperPath, qemuPath }) -> string`

- [ ] **Step 1: Write failing wrapper and launchd rendering tests**

Extend the existing launchd test and add wrapper assertions:

```js
test("stable wrappers recover only a broken deployment-owned Node binding", () => {
  const wrapper = renderStablePiWrapper({
    deploymentRoot: "/Users/test/deployment",
    nodePath: "/Users/test/deployment/node-current/node",
    nodeRecoveryPath: "/opt/homebrew/opt/node/bin/node",
    launcherPath: "/Users/test/deployment/controller/runtime/experiments/gondolin/safe-rpc-launcher.mjs",
  });
  assert.match(wrapper, /NODE='\/Users\/test\/deployment\/node-current\/node'/);
  assert.match(wrapper, /RECOVERY_NODE='\/opt\/homebrew\/opt\/node\/bin\/node'/);
  assert.match(wrapper, /runtime-repin/);
  assert.match(wrapper, /\/usr\/bin\/env -i/);
  assert.doesNotMatch(wrapper, /Cellar\/node/);
  assert.equal((wrapper.match(/controller\.sha256/g) ?? []).length, 1);
});

test("launchd reuses the stable Pi wrapper instead of pinning Node", () => {
  const plist = renderLaunchAgentPlist({
    home: "/Users/test&user",
    deploymentRoot: "/Users/test&user/.local/share/pi<guard>",
    piWrapperPath: "/Users/test&user/.local/share/pi<guard>/pi",
  });
  assert.match(plist, /<string>.*\/pi<\/string>/);
  assert.match(plist, /<string>update<\/string>/);
  assert.doesNotMatch(plist, /Cellar\/node|opt\/node\/bin\/node/);
});
```

Assert that both wrappers pass only `HOME`, fixed `PATH`, `PI_GONDOLIN_DEPLOYMENT_ROOT`, and deployment-private `TMPDIR` through `/usr/bin/env -i`. Assert recovery occurs only after existing manifest checks and only inside a `[ ! -x "$NODE" ]` branch. Preserve exact RPC refusal strings.

- [ ] **Step 2: Run the rendering tests and verify RED**

Run: `node --test --test-name-pattern='stable wrappers|launchd reuses' test/transactional-updater.test.mjs`

Expected: FAIL because stable wrapper renderers are private, accept no recovery path, and launchd embeds `nodePath`.

- [ ] **Step 3: Implement the inline recovery block in both stable wrappers**

Export the stable renderers and render this behavior after existing manifest checks:

```sh
if [ ! -x "$NODE" ]; then
  [ -x "$RECOVERY_NODE" ] || refuse
  /usr/bin/env -i \
    HOME="$HOME" \
    PATH='/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin' \
    PI_GONDOLIN_DEPLOYMENT_ROOT="$ROOT" \
    TMPDIR="$ROOT/tmp" \
    "$RECOVERY_NODE" "$ROOT/controller/update-local.mjs" runtime-repin >/dev/null || refuse
  [ -x "$NODE" ] || refuse
fi
```

Before rendering, create `$ROOT/tmp` as an owned mode-0700 directory. Keep the code duplicated in the two stable templates. Candidate wrappers remain unchanged. Change launchd `ProgramArguments` to `[piWrapperPath, "update"]`.

- [ ] **Step 4: Run focused and full unit tests**

Run: `node --test --test-name-pattern='stable wrappers|launchd' test/transactional-updater.test.mjs`

Run: `npm test`

Expected: all tests PASS, including unchanged RPC and launchd output-neutralization assertions.

- [ ] **Step 5: Commit wrapper changes**

```bash
git add experiments/gondolin/deployment-controller.mjs test/transactional-updater.test.mjs
git commit -m "feat(runtime): recover stale Node bindings from stable wrappers"
```

---

### Task 3: Static validation and runtime-repin controller action

**Files:**
- Modify: `experiments/gondolin/deployment-controller.mjs:720-790, 923-1005`
- Modify: `experiments/gondolin/update-local.mjs:1-65`
- Modify: `test/transactional-updater.test.mjs`

**Interfaces:**
- Consumes: `inspectRuntimeBinding()`, `promoteRuntimeBinding()`, `homebrewRecoveryAnchor()`, and `buildRecoveryEnvironment()` from Task 1.
- Produces: `deploymentStaticStatusV3({ home, deploymentRoot }) -> StaticDeploymentStatus`
- Produces: `runtimeRepinV3({ home, deploymentRoot, qualificationGate }) -> Promise<RuntimeBinding>`; `qualificationGate` is optional and defaults to the real current-release qualification. It is never set from CLI input.
- Produces: private `readNodeVersion(nodePath, environment) -> string`, which runs `nodePath --version` and accepts only `^v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$`.
- Changes: CLI action `runtime-repin` accepts zero arguments only.

- [ ] **Step 1: Write failing static-validation tests**

Create a fixture whose exact Node target is absent but whose state, installed links, wrapper hashes, controller/runtime manifests, current link, release metadata, release manifest, and binding metadata are valid. Assert:

```js
const status = deploymentStaticStatusV3({ home: fixture.home, deploymentRoot: fixture.root });
assert.equal(status.staticIntegrityPassed, true);
assert.equal(status.runtimeExecutable, false);
assert.equal(fixture.executionCount(), 0);
```

Mutate each security-critical artifact independently and assert `staticIntegrityPassed === false`. Assert the function never invokes Pi, RPC entry, the launcher, npm, QEMU, or the missing Node.

- [ ] **Step 2: Run the static-validation tests and verify RED**

Run: `node --test --test-name-pattern='static deployment' test/transactional-updater.test.mjs`

Expected: FAIL because `deploymentStaticStatusV3` does not exist.

- [ ] **Step 3: Extract static validation from deployment status**

Move the non-executing checks currently embedded in `deploymentStatusV3` into `deploymentStaticStatusV3`. Keep dynamic probes in `deploymentStatusV3` and require both static integrity and all current execution refusals for `deployed: true`. Return explicit booleans without raw paths or command output. Preserve dynamic status support for a legacy direct-path v3 state until adoption, and add an assertion that the current restored deployment remains reportable before migration.

- [ ] **Step 4: Run the static-validation and existing status tests**

Run: `node --test --test-name-pattern='static deployment|statut agrégé' test/transactional-updater.test.mjs`

Expected: PASS with unchanged fail-closed aggregate behavior.

- [ ] **Step 5: Write failing runtime-repin orchestration tests**

Cover the administrative transaction:

```js
test("runtime repin qualifies the current release before switching the binding", async () => {
  const fixture = await brokenV3BindingFixture();
  try {
    const events = [];
    const result = await runtimeRepinV3({
      home: fixture.home,
      deploymentRoot: fixture.root,
      qualificationGate: async ({ candidateNodePath, releaseRoot, environment }) => {
        events.push({ candidateNodePath, releaseRoot, environment });
        return true;
      },
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].candidateNodePath, fixture.recoveryCanonicalNode);
    assert.equal(events[0].environment.OPENAI_API_KEY, undefined);
    assert.equal(result.canonicalNodePath, fixture.recoveryCanonicalNode);
    assert.equal(inspectRuntimeBinding({ deploymentRoot: fixture.root, requireExecutable: true }).active, true);
  } finally {
    fixture.cleanup();
  }
});
```

Also assert refusal when static integrity fails, the active target still works, `state.nodeRecoveryPath` differs from the invoked anchor, `process.execPath` is outside the accepted keg policy, the update lock is held, or qualification returns false. In every refusal assert `node-current` is byte-for-byte unchanged.

- [ ] **Step 6: Run repin tests and verify RED**

Run: `node --test --test-name-pattern='runtime repin' test/transactional-updater.test.mjs`

Expected: FAIL because `runtimeRepinV3` and the route do not exist.

- [ ] **Step 7: Implement runtime-repin orchestration and CLI routing**

The controller sequence is fixed:

```js
const paths = deploymentPaths(home, deploymentRoot);
const releaseLock = acquireUpdateLock(paths.deploymentRoot);
try {
  const status = deploymentStaticStatusV3({ home, deploymentRoot: paths.deploymentRoot });
  if (!status.staticIntegrityPassed) throw new Error("deployment-pre-repin-invalid");
  if (status.runtimeExecutable) throw new Error("node-runtime-still-healthy");
  const { state, releaseRoot } = stateAndCurrent(paths);
  const candidateNodePath = realpathSync(process.execPath);
  const expectedAnchor = state.nodeRecoveryPath;
  if (homebrewRecoveryAnchor(candidateNodePath) !== expectedAnchor
    || realpathSync(expectedAnchor) !== candidateNodePath) {
    throw new Error("node-runtime-recovery-mismatch");
  }
  const recoveryEnvironment = buildRecoveryEnvironment({
    deploymentRoot: paths.deploymentRoot,
    home,
  });
  return await promoteRuntimeBinding({
    deploymentRoot: paths.deploymentRoot,
    canonicalNodePath: candidateNodePath,
    nodeVersion: readNodeVersion(candidateNodePath, recoveryEnvironment),
    qualifiedAt: new Date().toISOString(),
    source: "homebrew-recovery",
    qualificationGate: async () => qualificationGate({
      candidateNodePath,
      releaseRoot,
      environment: recoveryEnvironment,
    }),
  });
} finally {
  releaseLock();
}
```

The real default gate calls `qualifyRelease` with the current release and candidate path under the minimal recovery environment. Do not call `updateV3`, `fetchLatestRelease`, npm, or extension update. In `update-local.mjs`, accept `runtime-repin` only with zero trailing arguments and never accept a path from argv or environment.

- [ ] **Step 8: Run focused and full tests**

Run: `node --test --test-name-pattern='runtime repin|static deployment|statut agrégé' test/transactional-updater.test.mjs`

Run: `npm test`

Expected: all tests PASS with no changed RPC refusal behavior.

- [ ] **Step 9: Commit controller recovery**

```bash
git add experiments/gondolin/deployment-controller.mjs experiments/gondolin/update-local.mjs test/transactional-updater.test.mjs
git commit -m "feat(runtime): qualify and repin missing Node runtimes"
```

---

### Task 4: Fresh-install runtime binding

**Files:**
- Modify: `experiments/gondolin/deployment-controller.mjs:637-715`
- Modify: `test/transactional-updater.test.mjs`

**Interfaces:**
- Consumes: wrapper renderers from Task 2 and runtime-binding promotion from Task 1.
- Produces: `buildDeploymentRuntimeState({ deploymentRoot, canonicalNodePath, npmPath }) -> object`.
- Changes: fresh v3 state adds `runtimeBindingVersion`, `nodeRecoveryPath`, binding-backed `nodePath`, and binding-backed `npmCommand[0]`.

- [ ] **Step 1: Write failing fresh-layout tests**

Add a pure `buildDeploymentRuntimeState` helper and assert its exact state surface:

```js
assert.equal(state.version, 3);
assert.equal(state.runtimeBindingVersion, 1);
assert.equal(state.nodePath, join(deploymentRoot, "node-current", "node"));
assert.equal(state.nodeRecoveryPath, "/opt/homebrew/opt/node/bin/node");
assert.deepEqual(state.npmCommand, [state.nodePath, expectedNpmPath]);
assert.equal(inspectRuntimeBinding({ deploymentRoot, requireExecutable: true }).canonicalNodePath, canonicalNodePath);
```

Assert wrappers contain the binding path and recovery anchor, controller and wrapper hashes match, and the launchd plist contains the Pi wrapper rather than Node.

- [ ] **Step 2: Run fresh-layout tests and verify RED**

Run: `node --test --test-name-pattern='fresh v3 runtime binding' test/transactional-updater.test.mjs`

Expected: FAIL because fresh install still stores `realpathSync(process.execPath)` directly.

- [ ] **Step 3: Wire bindings into fresh installation**

During staging, derive the canonical Node and recovery anchor, then use `promoteRuntimeBinding` with the existing migrated-release qualification as its gate. Do not run the same qualification twice. Render stable wrappers against the final `node-current/node` path. Keep the final deployment rename and existing Pi-release link rollback behavior. Set `npmCommand[0]` to the binding-backed path and retain the canonical npm CLI path as element 1.

- [ ] **Step 4: Run focused and full tests**

Run: `node --test --test-name-pattern='fresh v3 runtime binding|candidate qualifiée|smoke post-activation' test/transactional-updater.test.mjs`

Run: `npm test`

Expected: all tests PASS.

- [ ] **Step 5: Commit fresh-install wiring**

```bash
git add experiments/gondolin/deployment-controller.mjs test/transactional-updater.test.mjs
git commit -m "feat(runtime): install Pi with a qualified Node binding"
```

---

### Task 5: Crash-recoverable adoption of healthy and broken v3 deployments

**Files:**
- Create: `experiments/gondolin/runtime-adoption.mjs`
- Create: `test/runtime-adoption.test.mjs`
- Modify: `experiments/gondolin/deployment-controller.mjs:662-724`
- Modify: `test/transactional-updater.test.mjs`

**Interfaces:**
- Produces: `ADOPTION_JOURNAL_VERSION = 1`.
- Produces: `beginRuntimeAdoption({ deploymentRoot, artifacts }) -> AdoptionJournal`.
- Produces: `advanceRuntimeAdoption({ deploymentRoot, expectedPhase, nextPhase }) -> AdoptionJournal`.
- Produces: `recoverRuntimeAdoption({ deploymentRoot, verifyInstalled, restoreBackups, finishActivation }) -> Promise<"none" | "rolled-back" | "completed">`.
- Produces: `adoptRuntimeBindingV3({ home, projectRoot, deploymentRoot, interruptionPoint }) -> Promise<DeploymentStatus>`; `interruptionPoint` is an internal test hook and is never accepted by CLI.
- Changes: `installV3()` routes a direct-path v3 state into adoption and recovers an existing private adoption journal before other work.

- [ ] **Step 1: Write failing adoption-preservation tests**

Build v3 fixtures matching the currently deployed direct-path layout. Run adoption once with a healthy old Node and once after removing the old executable. For the broken case, keep path-policy tests separate and pass the source controller's canonical Node through the internal `qualificationGate` seam; the CLI never accepts an executable path or a policy override.

Snapshot before adoption:

```js
const before = {
  current: readlinkSync(join(root, "current")),
  previous: readlinkSync(join(root, "previous")),
  releaseHashes: hashReleaseTrees(join(root, "releases")),
};
```

After adoption assert the snapshot is unchanged, `runtimeBindingVersion === 1`, `nodePath` uses `node-current/node`, the controller/runtime/wrapper hashes pass, and the new launchd plist invokes the stable Pi wrapper.

- [ ] **Step 2: Run adoption tests and verify RED**

Run: `node --test --test-name-pattern='adopts .* v3 deployment' test/transactional-updater.test.mjs`

Expected: FAIL because `installV3` currently returns status immediately whenever `deployment.json` exists.

- [ ] **Step 3: Implement staged adoption with a private journal**

Implement the journal primitives in `runtime-adoption.mjs`. Use `$deploymentRoot/adoption` with mode 0700. In tests, use concrete 64-character digests and assert the private `journal.json` has this exact non-PII shape:

```json
{
  "version": 1,
  "phase": "prepared",
  "artifacts": {
    "controller": { "oldSha256": "0000000000000000000000000000000000000000000000000000000000000000", "newSha256": "1111111111111111111111111111111111111111111111111111111111111111" },
    "pi": { "oldSha256": "2222222222222222222222222222222222222222222222222222222222222222", "newSha256": "3333333333333333333333333333333333333333333333333333333333333333" },
    "pi-gondolin-rpc": { "oldSha256": "4444444444444444444444444444444444444444444444444444444444444444", "newSha256": "5555555555555555555555555555555555555555555555555555555555555555" },
    "deployment.json": { "oldSha256": "6666666666666666666666666666666666666666666666666666666666666666", "newSha256": "7777777777777777777777777777777777777777777777777777777777777777" },
    "launchd": { "oldSha256": "", "newSha256": "8888888888888888888888888888888888888888888888888888888888888888" }
  }
}
```

Allowed phases are `prepared`, `artifacts-installed`, `binding-active`, `launchd-loaded`, and `complete`. Backups and staged files live inside the private adoption directory and are addressed by fixed names, not paths from the journal. Write and fsync each phase before the corresponding mutation. Never persist a home path, command, environment value, user identifier, or error payload.

Implement a private `durableWriteJournal()` that writes a sibling temporary file with `flag: "wx"`, calls `fsyncSync` on its file descriptor, renames it over `journal.json`, and calls `fsyncSync` on the adoption directory descriptor. The journal phase must survive process termination before its corresponding artifact mutation begins.

For a broken old Node, validate static integrity then qualify with the source process's canonical Homebrew Node. For a healthy old Node, qualify with the existing canonical target. Install controller, wrappers, state, and plist only after qualification. Activate `node-current` after artifacts are installed.

- [ ] **Step 4: Write failing interruption recovery tests**

For each phase, inject a controlled interruption after the phase is durable:

```js
for (const phase of ["prepared", "artifacts-installed", "binding-active", "launchd-loaded"]) {
  const fixture = await directPathV3Fixture();
  await assert.rejects(
    adoptRuntimeBindingV3({
      home: fixture.home,
      projectRoot: fixture.projectRoot,
      deploymentRoot: fixture.root,
      interruptionPoint: phase,
    }),
    /adoption-test-interruption/,
  );
  await installV3({ home: fixture.home, projectRoot: fixture.projectRoot, deploymentRoot: fixture.root });
  assert.equal(deploymentStaticStatusV3({ home: fixture.home, deploymentRoot: fixture.root }).staticIntegrityPassed, true);
  assert.deepEqual(hashReleaseTrees(join(fixture.root, "releases")), fixture.releaseHashesBefore);
  fixture.cleanup();
}
```

Assert that malformed, symlinked, non-owned, overly permissive, or unknown-version journals fail closed without touching artifacts.

- [ ] **Step 5: Run interruption tests and verify RED**

Run: `node --test --test-name-pattern='adoption interruption|adoption journal' test/transactional-updater.test.mjs`

Expected: FAIL because journal recovery does not exist.

- [ ] **Step 6: Implement deterministic journal recovery**

In `runtime-adoption.mjs`, validate the journal version, exact phase union, fixed artifact-key set, digest syntax, file ownership, modes, and absence of symlinks before invoking callbacks. On `prepared`, call `restoreBackups` and return `"rolled-back"`. On `artifacts-installed`, require `verifyInstalled()` then call `finishActivation`; otherwise restore. On `binding-active`, require `verifyInstalled()` then call `finishActivation`; otherwise restore. On `launchd-loaded`, require `verifyInstalled()` and return `"completed"`; otherwise restore. The controller callbacks reload or restore launchd and run the smoke gates. Keep `current`, `previous`, and releases outside every replacement list.

- [ ] **Step 7: Run adoption tests and full unit suite**

Run: `node --test --test-name-pattern='adopts .* v3 deployment|adoption interruption|adoption journal' test/transactional-updater.test.mjs`

Run: `node --test test/runtime-adoption.test.mjs`

Run: `npm test`

Expected: all tests PASS, including release-byte preservation.

- [ ] **Step 8: Commit v3 adoption**

```bash
git add experiments/gondolin/runtime-adoption.mjs experiments/gondolin/deployment-controller.mjs test/runtime-adoption.test.mjs test/transactional-updater.test.mjs
git commit -m "feat(runtime): adopt v3 deployments with crash recovery"
```

---

### Task 6: Original regression E2E and blocking coverage

**Files:**
- Modify: `test/transactional-updater.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: source adoption, rendered wrappers, CLI `runtime-repin`, and immutable bindings from Tasks 1-5.
- Produces: `test:runtime-lifecycle:coverage` package script included by `check`.

- [ ] **Step 1: Write the failing end-to-end keg-removal regression**

Create an isolated deployment whose old binding targets a disposable executable wrapper that delegates to the current test Node. Configure its fixed recovery anchor as the machine's real `/opt/homebrew/opt/node/bin/node` or `/usr/local/opt/node/bin/node`, selected by `homebrewRecoveryAnchor(realpathSync(process.execPath))`. Delete only the disposable wrapper to reproduce a missing keg; never create, replace, rename, or delete any real Homebrew path. Execute this sequence through child processes:

```js
assert.equal(runPi(fixture, ["--version"]).stdout.trim(), fixture.piVersion);
renameSync(fixture.oldKeg, `${fixture.oldKeg}.removed`);
const recovered = runPi(fixture, ["--version"], {
  OPENAI_API_KEY: "must-not-cross-recovery",
  PWD: "/private/project-path",
});
assert.equal(recovered.status, 0);
assert.equal(recovered.stdout.trim(), fixture.piVersion);
assert.equal(fixture.recoveryEnvironment().OPENAI_API_KEY, undefined);
assert.equal(fixture.recoveryEnvironment().PWD, undefined);
assert.equal(inspectRuntimeBinding({ deploymentRoot: fixture.deploymentRoot, requireExecutable: true }).nodeVersion, "v26.8.1");
assert.equal(fixture.releaseHashesAfter(), fixture.releaseHashesBefore());
```

Assert the previous binding generation remains present and its metadata contains no fixture home, project path, secret, command, or user identifier.

- [ ] **Step 2: Run the E2E test and verify RED**

Run: `node --test --test-name-pattern='recovers after Homebrew removes' test/transactional-updater.test.mjs`

Expected: FAIL at the old missing-keg execution before all integration wiring is complete.

- [ ] **Step 3: Complete only the integration gaps exposed by the E2E**

Adjust existing functions without adding new policy: ensure the wrapper checks the binding before `update` routing, the recovery action uses the deployed controller, the new binding is active before the wrapper retries, and original argv is preserved exactly. Do not add retry loops, alternate runtimes, or network fallback.

- [ ] **Step 4: Add blocking runtime-binding coverage**

Add this package script:

```json
"test:runtime-lifecycle:coverage": "node --test --experimental-test-coverage --test-coverage-include=experiments/gondolin/runtime-binding.mjs --test-coverage-include=experiments/gondolin/runtime-adoption.mjs --test-coverage-lines=95 --test-coverage-branches=90 --test-coverage-functions=100 test/runtime-binding.test.mjs test/runtime-adoption.test.mjs"
```

Insert `npm run test:runtime-lifecycle:coverage` into `check` immediately after the existing transactional coverage command.

- [ ] **Step 5: Run E2E, coverage, and repository tests**

Run: `node --test --test-name-pattern='recovers after Homebrew removes' test/transactional-updater.test.mjs`

Run: `npm run test:runtime-lifecycle:coverage`

Run: `npm test`

Expected: regression PASS, coverage thresholds PASS, and full unit suite PASS with zero failures or warnings.

- [ ] **Step 6: Commit regression and coverage**

```bash
git add test/transactional-updater.test.mjs package.json
git commit -m "test(runtime): cover Homebrew Node keg replacement"
```

---

### Task 7: ADR, operator documentation, and full verification

**Files:**
- Modify: `docs/adr-0001-transactional-pi-updates.md`
- Modify: `experiments/gondolin/README.md`

**Interfaces:**
- Documents: automatic recovery behavior, explicit `runtime-repin`, state fields, audit binding metadata, Homebrew trust boundary, failure codes, and source `install` adoption.

- [ ] **Step 1: Update the accepted ADR**

Add a dated amendment that states:

- normal execution follows `node-current` to an immutable qualified binding;
- Homebrew is the interpreter provenance authority;
- candidate execution is restricted to secret-free administrative and qualification workloads;
- activation is one atomic symlink switch;
- prior binding metadata is retained without PII;
- controller adoption is crash-recoverable rather than falsely described as one-operation atomic.

- [ ] **Step 2: Add operator commands and refusal behavior to the Gondolin README**

Document these exact commands:

```sh
npm run transactional:install
npm run transactional:status
PI_GONDOLIN_DEPLOYMENT_ROOT="$HOME/.local/share/pi-harness-challenger/gondolin-rpc/v3" \
  /opt/homebrew/opt/node/bin/node experiments/gondolin/update-local.mjs runtime-repin
```

Explain that automatic recovery occurs only when the active exact binding is broken; explicit repin refuses a healthy binding; no Pi update occurs; unsupported non-Homebrew runtimes fail closed. Include state and binding metadata examples containing synthetic `/opt/homebrew` paths only.

- [ ] **Step 3: Run documentation and repository checks**

Run: `npm run lint:comments`

Run: `git diff --check`

Run: `npm run test:runtime-lifecycle:coverage`

Run: `npm run check`

Expected: every command exits 0; coverage meets all thresholds; test and smoke output contains zero failures and zero warnings.

- [ ] **Step 4: Audit the final diff against the four decision axes**

Run: `git diff --stat 1ef6483..HEAD`

Run: `git diff 1ef6483..HEAD -- experiments/gondolin/runtime-binding.mjs experiments/gondolin/deployment-controller.mjs experiments/gondolin/update-local.mjs package.json docs/adr-0001-transactional-pi-updates.md experiments/gondolin/README.md test/runtime-binding.test.mjs test/transactional-updater.test.mjs`

Verify explicitly:

- security: no PATH runtime selection, secret-free recovery, fail-closed malformed state, unchanged RPC refusals;
- quality: strict validation, red-green evidence, no swallowed failures, zero warnings;
- performance: no additional healthy-path shell or Node process and no new hashing;
- completeness: regression E2E, blocking coverage, ADR, commands, audit evidence, healthy and broken v3 adoption.

- [ ] **Step 5: Commit documentation**

```bash
git add docs/adr-0001-transactional-pi-updates.md experiments/gondolin/README.md
git commit -m "docs(runtime): document qualified Node recovery"
```

- [ ] **Step 6: Request code review before local deployment**

Review `1ef6483..HEAD` with the repository checklist. Resolve every verified security, correctness, performance, and completeness finding through new red-green cycles. Re-run `npm run check` after the final review fix.

- [ ] **Step 7: Adopt the local deployment only after green review**

Run from the restored source checkout:

```sh
npm run transactional:install
npm run transactional:status
pi --version
```

Then verify direct RPC still refuses:

```sh
pi --mode rpc
```

Expected: `transactional:install` and status exit 0 with `deployed: true`; `pi --version` reports the qualified release; direct RPC exits 64 with exactly `pi-rpc-launcher-required`; active binding metadata points to the current canonical Homebrew Node and contains no PII.

If any post-adoption smoke fails, run the documented journal recovery through `npm run transactional:install`, verify rollback hashes, and do not claim deployment success.
