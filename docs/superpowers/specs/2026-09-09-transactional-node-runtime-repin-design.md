# Transactional Node Runtime Repin

## Status

Proposed for implementation on `fix/node-runtime-repin`.

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

### Stable deployment-owned binding

The deployment will own a `node-current` symlink. Its target is the canonical,
versioned Node executable that passed qualification. `deployment.json.nodePath`
and the Node prefix of `npmCommand` will reference this deployment-owned symlink
rather than the Homebrew keg directly.

The binding remains exact: the symlink target is a canonical keg path, not the
mutable Homebrew `opt` link. Switching interpreters consists of one atomic
symlink rename, so wrappers, state, and `launchd` configuration do not need to be
rewritten after each Homebrew upgrade.

### Runtime dispatcher

The controller will render a deployment-owned `node-dispatch` POSIX shell
entry point. Stable Pi wrappers and the `launchd` job will invoke this dispatcher
instead of embedding an exact keg path.

On the healthy path the dispatcher will:

1. verify the deployed controller manifest;
2. require `node-current` to be an owned symlink resolving to an executable;
3. `exec` the pinned interpreter with the original arguments.

No network request, version probe, hash of the Node binary, or extra Node process
is added to the healthy path.

### Restricted recovery path

At installation or migration time, the controller will derive a stable recovery
anchor from the active Homebrew Node layout:

- `/opt/homebrew/Cellar/node/.../bin/node` maps to
  `/opt/homebrew/opt/node/bin/node`;
- `/usr/local/Cellar/node/.../bin/node` maps to
  `/usr/local/opt/node/bin/node`.

Unsupported layouts fail closed instead of falling back to `PATH`. The recovery
anchor is embedded in the hashed dispatcher. It is never the normal runtime.

If and only if `node-current` is broken, the dispatcher invokes the deployed
controller with the recovery Node and the `runtime-repin` action. The controller
then:

1. acquires the existing private update lock;
2. validates ownership, modes, controller/runtime manifests, wrapper hashes,
   release metadata, and the current release manifest without executing the
   missing interpreter;
3. requires the recovery anchor to resolve to `process.execPath` and to a safe,
   canonical Homebrew Node executable;
4. qualifies the current Pi release under that exact candidate interpreter,
   with the existing offline CLI, RPC refusal, license, sandbox, budget, and E2E
   gates;
5. atomically replaces `node-current` only after every gate passes.

The dispatcher then executes the original command through the newly pinned
binding. A qualification failure leaves the broken binding unchanged and emits a
stable refusal code. It never weakens the deployment or silently runs an
unqualified interpreter.

`runtime-repin` does not fetch the latest Pi release and does not call
`updateV3`. Runtime compatibility and Pi release compatibility remain separate
transactions.

### Existing v3 deployment adoption

Running the source checkout's existing `install` action against a valid v3
deployment with a direct Node path will perform a one-time controller adoption:

1. stage the new controller, dispatcher, wrappers, state, and optional
   `launchd` plist;
2. validate their manifests and hashes;
3. qualify the current release under the still-working pinned Node;
4. commit the staged artifacts with rollback copies;
5. create `node-current` pointing to the previously qualified exact Node;
6. reload the `launchd` job and run the post-adoption smoke tests.

The migration does not modify `current`, `previous`, or any release directory.
On failure, all replaced deployment artifacts and the loaded `launchd` job are
restored. The deployment state remains version 3 because its public shape and
release semantics remain compatible; only `nodePath` changes from a direct
executable to the deployment-owned binding.

Fresh installs create this layout directly.

## Security Invariants

- No recovery executable is selected through `PATH`.
- Recovery is allowed only when the qualified binding is broken.
- The recovery Node must be under an accepted Homebrew Node keg and must match
  the fixed recovery anchor's canonical target.
- Controller and runtime manifests are verified before executing deployed
  recovery code.
- The current Pi release is fully qualified before the atomic binding switch.
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
- adoption rollback failure.

Shell entry points will map all recovery failures to the existing deployment
integrity refusal surface while the controller retains the precise identifier on
explicit administrative invocation.

## Testing

Implementation follows strict red-green TDD. Tests will cover:

1. Homebrew recovery-anchor derivation for Apple Silicon, Intel, malformed, and
   unsupported paths;
2. rendered wrappers and `launchd` configuration using `node-dispatch` without
   embedding a versioned keg;
3. healthy dispatch executing the existing pin without recovery;
4. a broken old keg being replaced only after a passing qualification gate;
5. a failing gate, unsafe symlink, mismatched recovery anchor, or healthy current
   pin leaving the binding unchanged;
6. v3 adoption preserving `current`, `previous`, and release bytes;
7. injected adoption failures restoring every replaced artifact;
8. the original regression scenario: install with one fake Homebrew keg, remove
   it, expose a second keg through the stable recovery anchor, and successfully
   execute Pi through the repaired binding;
9. the existing transactional updater coverage thresholds and full repository
   checks.

The local installed deployment will be adopted only after repository tests,
coverage, smoke tests, and a source review are green. Its post-deploy proof will
include `deploymentStatusV3`, `pi --version`, direct-RPC refusal, and a forced
runtime-repin rehearsal using isolated fixture paths rather than deleting a real
Homebrew keg.

## Documentation

The existing updater ADR will be amended with the runtime-binding decision and
the reason the mutable Homebrew anchor is recovery-only. The Gondolin README will
document normal behavior, explicit `runtime-repin`, refusal modes, and adoption
of an existing v3 deployment.

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

This duplicates the current recovery script's multi-file transaction. A single
deployment-owned symlink provides a smaller atomic state transition with fewer
integrity surfaces.
