# Transactional Harness Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Make every Pi harness mutation recoverable, fully integrity-checked, minimally exposed to caller state, locally auditable without PII, and reproducible in CI.

**Architecture:** Keep the adoption journal and a new release journal explicit because they recover different artifacts. Add focused modules for release transactions, operation audit, bounded JSON, and supply-chain policy; leave orchestration in the deployment controller. Upgrade existing bound deployments through adoption using controllerRevision 2.

**Tech Stack:** Node.js ESM, node:test, synchronous filesystem durability primitives, POSIX shell wrappers, launchd, npm-compatible registry protocol, GitHub Actions.

**Spec:** docs/superpowers/specs/2026-09-09-transactional-hardening-design.md

## Global Constraints

- Apply Security > Quality > Performance > Completeness.
- Preserve RPC refusal, launcher attestation, Homebrew recovery authority, and atomic node-current activation.
- Use only Node.js standard-library modules; the sole dependency change is the reviewed undici 6.x override.
- Persist no username, home path, project path, prompt, command, credential, proxy URL, or raw environment value in controller or audit JSON.
- Keep journals explicit; do not introduce a generic transaction framework.
- Start every production behavior change with a failing test.
- Never automatically delete releases or incomplete audit evidence.
- Emit stable error identifiers only.

---

### Task 1: Repair CI, setup, and dependency health

**Files:**
- Modify: .github/workflows/ci.yml
- Modify: package.json
- Modify: experiments/gondolin/package.json
- Modify: experiments/gondolin/package-lock.json
- Modify: test/gondolin-experiment.test.mjs

**Interfaces:**
- Produces: npm run setup:gondolin, CI runtime-lifecycle coverage, and exact MIT-licensed undici >=6.28.0 <7.

- [ ] **Step 1: Write failing repository-policy assertions**

~~~js
assert.match(ci, /runtime-adoption runtime-binding/);
assert.match(ci, /test\/runtime-adoption\.test\.mjs/);
assert.match(ci, /test\/runtime-binding\.test\.mjs/);
assert.match(ci, /npm run test:runtime-lifecycle:coverage/);
assert.equal(rootPackage.scripts["setup:gondolin"], "npm ci --ignore-scripts --prefix experiments/gondolin");
assert.ok(compareVersions(gondolinLock.packages["node_modules/undici"].version, "6.28.0") >= 0);
~~~

- [ ] **Step 2: Run node --test test/gondolin-experiment.test.mjs and observe failure for each absent policy.**
- [ ] **Step 3: Add both tests to CI inventory/execution, the runtime coverage step, setup:gondolin, and an exact compatible undici override; regenerate only the nested lockfile.**

~~~json
{
  "scripts": {
    "setup:gondolin": "npm ci --ignore-scripts --prefix experiments/gondolin"
  }
}
~~~
- [ ] **Step 4: Run the focused test and npm audit --omit=dev --prefix experiments/gondolin; require PASS and zero advisories.**
- [ ] **Step 5: Commit with message: ci: cover runtime lifecycle and dependency health.**

### Task 2: Recover only verified dead update locks

**Files:**
- Modify: experiments/gondolin/release-manager.mjs
- Modify: test/transactional-updater.test.mjs

**Interfaces:**
- Preserves: acquireUpdateLock(deploymentRoot) returning an idempotent release function.
- Produces: exact owner metadata with version, pid, nonce, acquiredAt.

- [ ] **Step 1: Write a test spawning a child that acquires the lock, prints locked, and exits without invoking the closure.**

~~~js
const child = spawnSync(process.execPath, ["--input-type=module", "--eval", childSource, fixture.root], { encoding: "utf8" });
assert.equal(child.stdout, "locked\n");
const release = acquireUpdateLock(fixture.root);
release();
~~~

- [ ] **Step 2: Run the dead update lock test and observe update-lock-active.**
- [ ] **Step 3: Validate owner schema/modes; reclaim only ESRCH through a UUID quarantine whose device, inode, and nonce still match; retry at most three times.**

~~~js
function lockOwnerAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error?.code === "ESRCH") return false; throw new Error("update-lock-owner-invalid"); }
}
~~~
- [ ] **Step 4: Add live PID, EPERM, malformed metadata, symlink, replaced inode/nonce, PID-reuse, and idempotent-release cases; run all update lock tests green.**
- [ ] **Step 5: Commit with message: fix(updater): reclaim verified dead locks.**

### Task 3: Publish adoption journals atomically

**Files:**
- Modify: experiments/gondolin/runtime-adoption.mjs
- Modify: test/runtime-adoption.test.mjs
- Modify: test/transactional-updater.test.mjs

**Interfaces:**
- Preserves: beginRuntimeAdoption, advanceRuntimeAdoption, recoverRuntimeAdoption.
- Produces: removeAbandonedAdoptionPreparations({ deploymentRoot }).

- [ ] **Step 1: Write a child-process test terminating immediately before publication and assert adoption is absent while a private preparation directory remains.**
- [ ] **Step 2: Run test/runtime-adoption.test.mjs and observe the pre-fix publication failure.**
- [ ] **Step 3: Build .adoption-prepare-UUID, fsync journal/directory, rename to adoption, fsync deployment root, and safely remove only validated abandoned preparations.**

~~~js
durableWriteJournal(preparationRoot, join(preparationRoot, "journal.json"), journal);
fsyncDirectory(preparationRoot);
renameSync(preparationRoot, join(deploymentRoot, "adoption"));
fsyncDirectory(deploymentRoot);
~~~
- [ ] **Step 4: Run runtime-adoption tests and adoption-focused transactional tests green.**
- [ ] **Step 5: Commit with message: fix(runtime): publish adoption journals durably.**

### Task 4: Implement the explicit release transaction journal

**Files:**
- Create: experiments/gondolin/release-transaction.mjs
- Create: test/release-transaction.test.mjs
- Modify: package.json
- Modify: .github/workflows/ci.yml

**Interfaces:**
- Produces: beginReleaseTransaction, advanceReleaseTransaction, inspectReleaseTransaction, recoverReleaseTransaction, completeReleaseTransaction.
- Phases: prepared, links-active, qualified, state-active, complete.

- [ ] **Step 1: Write exact-schema, permissions, phase-transition, unknown-field, and unsafe-live-state tests.**

~~~js
const transaction = beginReleaseTransaction({
  deploymentRoot: root,
  kind: "promotion",
  releaseId: "2.0.0-deadbeef0000",
  before: { state, current: "releases/1.0.0-old", previous: null },
  after: { state: nextState, current: "releases/2.0.0-deadbeef0000", previous: "releases/1.0.0-old" },
});
assert.equal(transaction.phase, "prepared");
~~~

- [ ] **Step 2: Run the new suite and observe module-not-found.**
- [ ] **Step 3: Implement private durable snapshots and asymmetric recovery: rollback prepared/links-active; complete qualified/state-active/complete; rename promoted release back to candidate without deletion.**

~~~js
const RECOVERY = new Map([
  ["prepared", "rollback"],
  ["links-active", "rollback"],
  ["qualified", "complete"],
  ["state-active", "complete"],
  ["complete", "complete"],
]);
~~~
- [ ] **Step 4: Add a blocking release-transaction coverage script and CI step, then run unit and coverage tests green.**
- [ ] **Step 5: Commit with message: feat(updater): add release transaction journal.**

### Task 5: Add bounded non-PII operation audit

**Files:**
- Create: experiments/gondolin/operation-audit.mjs
- Create: test/operation-audit.test.mjs
- Modify: package.json
- Modify: .github/workflows/ci.yml

**Interfaces:**
- Produces: beginAuditOperation, completeAuditOperation, auditStatus, pruneCompletedAuditOperations.
- Returns: operationId and auditComplete.

- [ ] **Step 1: Write tests for exact immutable JSON, modes, enums, PII rejection, incomplete evidence, idempotent completion, and retention of 256 completed operations without pruning incomplete ones.**
- [ ] **Step 2: Run the audit suite and observe module-not-found.**
- [ ] **Step 3: Implement audit/operations/UUID/started.json and result.json; fail before mutation if start persistence fails; report auditComplete false after an applied atomic mutation if result persistence fails.**

~~~js
return resultWritten
  ? { operationId, auditComplete: true }
  : { operationId, auditComplete: false };
~~~
- [ ] **Step 4: Add a blocking audit coverage script and CI step, then run unit and coverage tests green.**
- [ ] **Step 5: Commit with message: feat(updater): add bounded local operation audit.**

### Task 6: Integrate transaction and audit into promotion and rollback

**Files:**
- Modify: experiments/gondolin/deployment-controller.mjs
- Modify: experiments/gondolin/release-manager.mjs
- Modify: test/transactional-updater.test.mjs

**Interfaces:**
- updateV3 and rollbackV3 retain existing fields and add operationId, auditComplete.
- Recovery runs after lock acquisition and before ordinary state validation.

- [ ] **Step 1: Write child-process exits between link writes, after both links, after qualification, after state replacement, and during rollback; the next child must converge exactly.**
- [ ] **Step 2: Run release process crash and rollback process crash tests and observe inconsistent state.**
- [ ] **Step 3: Begin audit/journal before links, advance around qualification/state, complete audit before journal cleanup, and use the same recovery path for caught errors and process death.**

~~~js
const audit = beginAuditOperation(auditInput);
beginReleaseTransaction(transactionInput);
switchReleaseLinks(paths, afterLinks);
advanceReleaseTransaction({ deploymentRoot, expectedPhase: "prepared", nextPhase: "links-active" });
~~~
- [ ] **Step 4: Run release-transaction and full transactional-updater suites green, including failed state-write rollback.**
- [ ] **Step 5: Commit with message: fix(updater): recover release mutations after process death.**

### Task 7: Bound metadata and pin supply-chain endpoints

**Files:**
- Create: experiments/gondolin/bounded-json.mjs
- Create: experiments/gondolin/supply-chain-policy.json
- Create: test/bounded-json.test.mjs
- Modify: experiments/gondolin/deployment-controller.mjs
- Modify: test/transactional-updater.test.mjs
- Modify: package.json
- Modify: .github/workflows/ci.yml

**Interfaces:**
- Produces: readBoundedJsonResponse(response, { maxBytes: 131072 }).
- Policy exact keys: version, profile, sovereigntyStatus, releaseDescriptorUrl, registryUrl.

- [ ] **Step 1: Write Response-based tests below/at/above 128 KiB, JSON media-type tests, fatal UTF-8/JSON tests, exact HTTPS policy tests, and caller registry/proxy sentinel tests.**
- [ ] **Step 2: Run bounded-json and supply-chain-policy tests and observe missing implementation.**
- [ ] **Step 3: Read incrementally, cancel overflow, parse fatal UTF-8 JSON, manifest the policy, and pass registry via explicit npm --registry under a controller-built environment.**

~~~js
const reader = response.body.getReader();
if (receivedBytes > maxBytes) {
  await reader.cancel();
  throw new Error("release-descriptor-too-large");
}
~~~
- [ ] **Step 4: Add a blocking bounded-JSON coverage script and CI step, then run bounded-json and transactional-updater suites green.**
- [ ] **Step 5: Commit with message: fix(updater): bound and pin release metadata sources.**

### Task 8: Isolate every administrative child environment

**Files:**
- Modify: experiments/gondolin/deployment-controller.mjs
- Modify: test/transactional-updater.test.mjs
- Modify: test/runtime-binding.test.mjs

**Interfaces:**
- qualificationEnvironment(overrides, baseEnvironment) requires its base.
- deploymentStatusV3 uses buildRecoveryEnvironment.

- [ ] **Step 1: Inject provider, proxy, NODE_OPTIONS, NODE_PATH, npm registry, and project sentinels; capture all status/qualification/npm/smoke child environments and assert absence.**
- [ ] **Step 2: Run environment-focused tests and observe status leakage.**
- [ ] **Step 3: Remove defaults and pass allowlisted environments to all administrative children; retain caller environment only for deliberate interactive Pi delegation.**

~~~js
function qualificationEnvironment(overrides, baseEnvironment) {
  if (!baseEnvironment) throw new Error("child-environment-missing");
  return { ...baseEnvironment, PI_OFFLINE: "1", ...overrides };
}
~~~
- [ ] **Step 4: Run runtime-binding and transactional-updater suites green.**
- [ ] **Step 5: Commit with message: fix(runtime): isolate administrative child environments.**

### Task 9: Verify complete release trees and benchmark launch cost

**Files:**
- Modify: experiments/gondolin/release-manager.mjs
- Modify: experiments/gondolin/deployment-controller.mjs
- Create: experiments/gondolin/release-integrity-benchmark.mjs
- Modify: package.json
- Modify: test/transactional-updater.test.mjs

**Interfaces:**
- Produces: listReleaseManifestFiles(releaseRoot).
- benchmark:release-integrity emits fileCount, runs, medianMs, p95Ms, maxMs.

- [ ] **Step 1: Write a release whose CLI imports internal.js; mutate only internal.js and expect refusal. Add symlink, special-file, carriage-return, and duplicate-path cases.**
- [ ] **Step 2: Run complete release manifest tests and observe that transitive drift passes.**
- [ ] **Step 3: Remove npm .bin links, enumerate every regular file except critical.sha256, reject unsafe entries, and upgrade partial manifests only after old verification and full qualification via atomic rename plus directory fsync.**

~~~js
const manifestFiles = listReleaseManifestFiles(candidateRoot)
  .filter((path) => path !== "critical.sha256");
buildCriticalManifest(candidateRoot, manifestFiles, join(candidateRoot, "critical.sha256"));
~~~
- [ ] **Step 4: Implement 20-check benchmark and run updater tests plus npm run benchmark:release-integrity green.**
- [ ] **Step 5: Commit with message: fix(updater): verify complete release trees.**

### Task 10: Migrate state, refresh controller, document, deploy, and verify

**Files:**
- Modify: experiments/gondolin/deployment-controller.mjs
- Modify: experiments/gondolin/runtime-adoption.mjs
- Modify: experiments/gondolin/update-local.mjs
- Modify: test/transactional-updater.test.mjs
- Modify: test/runtime-adoption.test.mjs
- Modify: README.md
- Modify: experiments/gondolin/README.md
- Modify: docs/adr-0001-transactional-pi-updates.md
- Create: docs/sovereignty.md

**Interfaces:**
- State gains controllerRevision 2 and stores exact node-current/node.
- Runtime consumers resolve that value under the deployment root.
- installV3 refreshes revision-1 bound deployments while preserving binding and releases.

- [ ] **Step 1: Write tests for no home path, traversal refusal, revision 1 to 2 refresh, binding/release preservation, controller replacement, and process death at every refresh phase.**
- [ ] **Step 2: Run controller revision, relative state, and bound refresh tests and observe failure.**
- [ ] **Step 3: Store/resolve only node-current/node, derive wrapper root from its resolved location, preserve a valid binding during refresh, upgrade the partial active manifest, and add automatic audit-trigger provenance to launchd.**

~~~js
const STORED_NODE_PATH = "node-current/node";
function resolveStoredNodePath(deploymentRoot, storedPath) {
  if (storedPath !== STORED_NODE_PATH) throw new Error("deployment-runtime-path-invalid");
  return join(deploymentRoot, storedPath);
}
~~~
- [ ] **Step 4: Integrate audit start/result records into runtime adoption, runtime repin, and automation enable/disable; expose incomplete audit count in status without changing operational success after an applied mutation.**
- [ ] **Step 5: Copy and manifest release-transaction.mjs, operation-audit.mjs, bounded-json.mjs, and supply-chain-policy.json in deployed controller artifacts.**
- [ ] **Step 6: Document crash phases, drift boundary, launchd path exception, audit retention/deletion, refusal codes, dependency audit, and upstream-exception versus EU-mirror compatibility.**
- [ ] **Step 7: Run source gates, including every new module-specific coverage command and the exact CI inventory guard.**

~~~bash
npm run lint:comments
npm test
npm run test:transactional:coverage
npm run test:runtime-lifecycle:coverage
npm audit --omit=dev --prefix experiments/gondolin
~~~

- [ ] **Step 8: Refresh and verify the real deployment.**

~~~bash
npm run transactional:install
npm run transactional:status
npm run benchmark:release-integrity
npm run check
~~~

Expected: revision 2, no home path in state, healthy deployment, benchmark evidence, missing-keg E2E green, and full gate green.

- [ ] **Step 9: Run the solo review checklist, fix verified findings with new red-green cycles, and commit with message: docs: complete transactional hardening guidance.**
