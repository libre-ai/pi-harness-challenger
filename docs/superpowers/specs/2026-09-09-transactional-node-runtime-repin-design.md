# Transactional Node Runtime Repin

## Status

Revised after adversarial review. The automatic hardened-recovery direction is
accepted; this revision is pending final approval before implementation planning.

## Context

The Gondolin deployment currently records `realpathSync(process.execPath)` in
`deployment.json`, the Pi wrappers, and the `launchd` job. With Homebrew this
turns `/opt/homebrew/bin/node` into a versioned keg path such as
`/opt/homebrew/Cellar/node/26.7.0/bin/node`.

That exact pin is useful: Pi is always executed by the interpreter that passed
the deployment qualification gates. It is also brittle. `brew upgrade node`
removes the previous keg, so every entry point, including the updater that could
repair the deployment, loses its interpreter simultaneously.

The machine-local `pi-repin-node.sh` recovery script proved the recovery flow,
but it is not part of the archived source, is not exercised by CI, and invokes a
Pi release update after repinning. Runtime recovery must not be coupled to
installing a new Pi candidate.

## Decision Drivers

In priority order:

1. Preserve the fail-closed RPC and deployment-integrity boundaries.
2. Keep an exact, qualified Node interpreter binding during normal execution.
3. Make recovery atomic and independently testable.
4. Avoid per-launch hashing, network access, or unnecessary process creation on
   the healthy path.
5. Upgrade existing v3 deployments without reinstalling or mutating qualified
   Pi releases.

## Decision

### Immutable deployment-owned bindings

The deployment will keep immutable binding generations under
`node-bindings/<binding-id>/`. Each generation contains:

- an owned `node` symlink to the canonical, versioned Node executable;
- private metadata with `runtimeBindingVersion: 1`, the canonical path, the Node
  version, an ISO 8601 qualification timestamp, and the recovery source;
- a manifest covering the metadata and the symlink target text.

The metadata is an audit record, not a claim that hashing the small Node launcher
proves the integrity of its complete dynamic runtime. It contains no username,
command, project path, prompt, secret, or other personal data.

The deployment's `node-current` symlink selects one immutable binding generation.
Previous binding generations are retained as non-sensitive qualification evidence.
`deployment.json.nodePath` and the Node prefix of `npmCommand` reference
`node-current/node` rather than the Homebrew keg directly. An explicit
`runtimeBindingVersion: 1` state marker prevents old and new `nodePath` semantics
from being inferred from path shape. `deployment.json.nodeRecoveryPath` records
the fixed Homebrew recovery anchor rendered into the wrappers so explicit and
automatic recovery enforce the same authority.

The active binding remains exact: its inner symlink target is a canonical keg
path, not the mutable Homebrew `opt` link. Switching interpreters consists of one
atomic replacement of `node-current`, so wrappers, state, and `launchd`
configuration do not need to be rewritten after each Homebrew upgrade.

### Recovery integrated into stable wrappers

The two stable POSIX shell wrappers will contain the same short runtime-binding
check. This deliberate duplication follows the rule of three and avoids a second
shell `exec` on every Pi launch. Candidate wrappers continue to receive the exact
candidate Node path during qualification and do not contain recovery behavior.

On the healthy path each stable wrapper will:

1. perform its existing controller, runtime, and release manifest checks exactly
   once;
2. require `node-current` to select a binding whose `node` entry is a symlink
   resolving to an executable;
3. `exec` the pinned interpreter with the original arguments.

No network request, new manifest hash, version probe, Node binary hash, extra
shell, or extra Node process is added to the healthy path.

The deployment root is already private. Full ownership, mode, target-shape, and
binding-manifest validation remains in controller status, update, and recovery
paths rather than adding a `stat` subprocess to every healthy launch.

The `launchd` job invokes the stable Pi wrapper with `update`, reusing the same
integrity and recovery path instead of embedding a Node executable.

### Restricted recovery path

At installation or migration time, the controller will derive a stable recovery
anchor from the active Homebrew Node layout:

- `/opt/homebrew/Cellar/node/.../bin/node` maps to
  `/opt/homebrew/opt/node/bin/node`;
- `/usr/local/Cellar/node/.../bin/node` maps to
  `/usr/local/opt/node/bin/node`.

Unsupported layouts fail closed instead of falling back to `PATH`. The recovery
anchor is embedded in both hashed stable wrappers. It is never the normal runtime.

The Homebrew installation transaction is an explicit trust authority. The
harness does not independently attest Node provenance, whether Homebrew used a
bottle or a source build. Runtime qualification proves Pi/Gondolin compatibility;
it does not prove the authenticity or harmlessness of the Node interpreter that
executes the qualification controller.

If and only if `node-current/node` is broken, the wrapper invokes the deployed
controller with the recovery Node and the `runtime-repin` action. It uses
`/usr/bin/env -i` with an explicit allowlist containing only the deployment root,
the required fixed system path, a private temporary directory, and the minimum
home value required to locate the deployment. Provider credentials, tokens,
project paths, prompts, and the caller's remaining environment are not inherited.
The controller then:

1. acquires the existing private update lock;
2. validates ownership, modes, controller/runtime manifests, wrapper hashes,
   runtime-binding metadata, release metadata, and the current release manifest
   without executing the missing interpreter;
3. requires the recovery anchor to resolve to `process.execPath` and to a safe,
   canonical Homebrew Node executable, and requires it to equal the state's
   `nodeRecoveryPath`;
4. creates a new immutable binding generation without activating it;
5. qualifies the current Pi release under that exact candidate interpreter,
   with the existing offline CLI, RPC refusal, license, sandbox, budget, and E2E
   gates, all under a minimal allowlisted environment;
6. atomically replaces `node-current` only after every gate passes.

The wrapper then executes the original command through the newly pinned binding.
A qualification failure leaves the active binding unchanged and emits a stable
refusal code. Before activation, the candidate interpreter runs only the
manifest-verified administrative controller and isolated Pi/Gondolin
qualification workloads. It receives no user project mount, provider credential,
prompt, or caller environment. This restricted execution relies on the explicit
Homebrew trust assumption; it is not a sandbox against a malicious interpreter.

`runtime-repin` does not fetch the latest Pi release and does not call
`updateV3`. Runtime compatibility and Pi release compatibility remain separate
transactions.

### Existing v3 deployment adoption

Running the source checkout's existing `install` action against a v3 deployment
with a direct Node path will perform a one-time controller adoption. It supports
both a healthy direct Node and the original failure state where that exact keg no
longer exists.

For a broken deployment, the source controller first performs the same static
ownership, manifest, wrapper-hash, link, release-metadata, and release-manifest
checks used by recovery. It then treats its own canonical Homebrew interpreter as
the candidate and qualifies the current release before adoption. It does not
require the missing old Node to execute.

Adoption will:

1. acquire the update lock and stop the existing `launchd` job;
2. stage the new controller, wrappers, state, first immutable runtime binding,
   and optional `launchd` plist;
3. validate their manifests and hashes;
4. qualify the current release under the selected candidate Node;
5. persist a private adoption journal containing only artifact names, hashes, and
   transaction phase, then replace the staged artifacts;
6. activate the first runtime binding with one atomic `node-current` switch;
7. reload the `launchd` job and run the post-adoption smoke tests;
8. mark the journal complete only after every post-adoption gate passes.

The migration does not modify `current`, `previous`, or any release directory.
On a caught failure, all replaced deployment artifacts and the loaded `launchd`
job are restored. On interruption or power loss, the next source `install`
invocation detects the journal and deterministically completes or rolls back the
recorded phase before attempting a new adoption. During any mixed phase the
wrappers fail closed. The adoption is therefore crash-recoverable; only routine
runtime promotion, which switches `node-current`, is a single-operation atomic
transition.

The deployment state remains version 3 because its public release semantics stay
compatible, but it gains the explicit `runtimeBindingVersion: 1` capability
marker and `nodeRecoveryPath`. `nodePath` changes from a direct executable to the
deployment-owned binding path.

Fresh installs create this layout directly.

## Security Invariants

- No recovery executable is selected through `PATH`.
- Recovery is allowed only when the qualified binding is broken.
- The recovery Node must be under an accepted Homebrew Node keg and must match
  the fixed recovery anchor's canonical target.
- Homebrew is an explicit interpreter-provenance trust authority; qualification
  is a compatibility decision, not a substitute for supply-chain verification.
- Recovery and every candidate child process receive a minimal allowlisted
  environment with no provider or project secrets.
- Controller and runtime manifests are verified before executing deployed
  recovery code.
- The current Pi release is fully qualified before the atomic binding switch.
- Each qualified binding leaves immutable, non-PII metadata and the previous
  binding remains available as audit evidence.
- No commands, project paths, prompts, secrets, or personal data are logged or
  persisted.
- Direct RPC and incomplete-launcher refusals remain unchanged.

## Error Handling

The controller will expose stable, non-sensitive refusal identifiers for:

- unsupported Node installation layout;
- unsafe or unexpected binding structure;
- missing recovery interpreter;
- recovery anchor/candidate mismatch;
- attempted repin while the current binding is healthy;
- current-release qualification failure;
- recovery environment contamination;
- incomplete adoption journal recovery;
- adoption rollback failure.

Shell entry points will map all recovery failures to the existing deployment
integrity refusal surface while the controller retains the precise identifier on
explicit administrative invocation.

## Testing

Implementation follows strict red-green TDD. Tests will cover:

1. Homebrew recovery-anchor derivation for Apple Silicon, Intel, malformed, and
   unsupported paths;
2. rendered wrappers and `launchd` configuration using `node-current` without
   embedding a versioned keg or adding a dispatcher;
3. healthy wrappers executing the existing pin without recovery, duplicate
   hashing, or an extra shell;
4. a broken old keg being replaced only after a passing qualification gate;
5. a failing gate, unsafe symlink, mismatched recovery anchor, or healthy current
   pin leaving the binding unchanged;
6. recovery processes receiving an allowlisted environment with caller secrets
   removed;
7. healthy and already-broken v3 adoption preserving `current`, `previous`, and
   release bytes;
8. injected adoption failures restoring every replaced artifact, plus simulated
   interruption at each journal phase followed by deterministic recovery;
9. the original regression scenario: install with one fake Homebrew keg, remove
   it, expose a second keg through the stable recovery anchor, and successfully
   execute Pi through the repaired binding;
10. immutable binding metadata, state capability marking, retained prior audit
    evidence, and zero persisted PII;
11. the existing transactional updater coverage thresholds and full repository
   checks.

The local installed deployment will be adopted only after repository tests,
coverage, smoke tests, and a source review are green. Its post-deploy proof will
include `deploymentStatusV3`, `pi --version`, direct-RPC refusal, and inspection
of the active immutable runtime binding. Runtime-repin failure and recovery are
proven end to end with isolated fixture paths; no real Homebrew keg is modified
for a demonstration.

## Documentation

The existing updater ADR will be amended with the runtime-binding decision, the
Homebrew trust assumption, the minimal recovery environment, and the reason the
mutable Homebrew anchor is recovery-only. The Gondolin README will document
normal behavior, explicit `runtime-repin`, refusal modes, audit metadata, and
adoption of healthy or broken v3 deployments.

## Out of Scope

- Adapting Pi 0.85.1's changed CLI entry point from `dist/cli.js` to
  `dist/bundle/cli.js`; that is a separate Pi-release compatibility decision.
- Managing QEMU upgrades; `qemuPath` has a similar lifecycle risk but requires
  distinct qualification and process-lifecycle analysis.
- Supporting arbitrary version managers or selecting interpreters from `PATH`.
- Moving Pi/Gondolin lifecycle management into `libre-ai/harness`.

## Rejected Alternatives

### Execute the mutable Homebrew symlink directly

This prevents the missing-file error but silently changes the runtime before
qualification and therefore weakens the core security invariant.

### Keep only the machine-local repin script

This remains manual, unversioned, and untested, and it cannot protect the
hourly `launchd` updater from the same stale path.

### Vendor Node inside the deployment

This provides a stable runtime but adds binary distribution, platform, license,
and security-update responsibilities disproportionate to the requested scope.

### Rewrite all wrappers after every Node upgrade

This duplicates the current recovery script's multi-file transaction. Immutable
binding generations plus a single `node-current` switch provide a smaller atomic
runtime state transition with fewer integrity surfaces.

### Add a separate runtime dispatcher

Only two stable wrappers need recovery behavior, and the `launchd` job can reuse
the Pi wrapper. A dispatcher would add another shell `exec` and risk duplicate
manifest verification on every healthy launch. The small recovery block is
therefore duplicated explicitly until the rule of three justifies extraction.
