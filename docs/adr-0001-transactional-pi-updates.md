# ADR-0001 — Transactional Pi updates behind Gondolin

- Status: accepted
- Scope: local Pi/Gondolin deployment

## Context

The v2 deployment patched the globally installed `rpc-entry.js`, pinned Pi 0.80.10 hashes, and made `pi update` fail until an explicit rollback. This protected the guarded artifact from an in-place npm replacement, but prevented routine Pi updates and depended on runtime files in a source checkout. Recomputing hashes after an update would prove only that bytes changed, not that the RPC and sandbox boundaries remained compatible.

Pi's native npm self-update replaces the global package in place. It provides no candidate qualification or atomic rollback boundary suitable for the Gondolin profile.

## Decision

Use a stable external controller and immutable, versioned Pi releases:

1. fetch the release descriptor from `pi.dev`;
2. allow only `@earendil-works/pi-coding-agent` and an exact version;
3. obtain and verify npm registry integrity metadata;
4. install with lifecycle scripts disabled into a private candidate directory;
5. audit the candidate package metadata and transitive licenses;
6. guard the candidate RPC entry and hash security-critical files;
7. run CLI, RPC refusal, budget, license, and no-host-write Gondolin gates;
8. atomically switch `previous` and `current` only after all candidate gates pass;
9. restore the former links if the post-activation smoke fails.

The deployed runtime is copied under the controller and fully hash-manifested. It does not import files from the source checkout.

A `launchd` user agent checks hourly and at load. It runs the same updater, writes stdout/stderr to `/dev/null`, and has an explicit executable path. An incompatible release is recorded as blocked so subsequent checks do not repeatedly start QEMU. `pi update --force` explicitly retries qualification.

## Command policy

- Core targets (`pi update`, `pi`, `self`, `--self`, `--all`) use the transactional updater.
- Model catalog and extension-only targets delegate to the active Pi release.
- Unknown or conflicting update targets are refused rather than delegated to a possible in-place self-update.
- Downgrades and package-name changes are refused.

## Consequences

### Positive

- Compatible Pi releases can be promoted automatically without a fail-open interval.
- Running Pi processes keep their release while new invocations follow the atomic `current` link.
- The prior qualified release remains immediately available.
- Source checkout deletion no longer breaks the deployed launcher.
- No provider prompt, command, raw project path, secret, or personal data is persisted by the updater.

### Negative

- Each qualified release keeps a complete Pi dependency tree.
- A real version change starts QEMU qualification before activation.
- An API-incompatible Pi release remains blocked until the controller is reviewed and changed; code adaptation is intentionally not automatic.
- Registry and `pi.dev` availability are required for checking a new release, but not for executing the active one.

## Rejected alternatives

- In-place update followed by new hashes: no atomic rollback and a compatibility claim without evidence.
- Removing Pi hashes from the wrapper: weakens the guarded RPC boundary.
- Keeping all updates manual: safer than blind updates but does not satisfy automatic compatible promotion.

## Amendment — qualified Node runtime bindings (2026-09-09)

Normal execution resolves `node-current/node`. `node-current` selects one immutable,
qualified binding generation whose inner link records the exact canonical Node
executable. A runtime promotion changes one symlink atomically; it does not rewrite
the Pi release, stable wrappers, or launchd job. Previous binding generations remain
as private audit evidence. Their metadata records only the binding identifier,
canonical Homebrew keg path, Node version, qualification timestamp, and recovery
source—never prompts, commands, project paths, credentials, or user identifiers.

Homebrew is the explicit interpreter-provenance authority. Recovery accepts only the
fixed Apple Silicon or Intel Homebrew `opt/node/bin/node` anchor resolving to the
controller's own canonical executable. It never searches `PATH`, accepts an executable
from argv, or falls back to another runtime. Before switching, the controller verifies
the deployed manifests and current release, then runs the existing offline CLI, RPC,
license, budget, sandbox, and E2E qualification gates under an allowlisted environment
without provider credentials or caller project state. This restriction limits what is
exposed to the candidate; it is not a sandbox against a malicious Homebrew interpreter.

Stable wrappers attempt recovery only when the active exact binding is not executable.
A healthy binding, unsupported installation layout, recovery-anchor mismatch, malformed
private state, or failed qualification is refused. Runtime recovery never fetches or
promotes a Pi release.

Adopting an older direct-path v3 deployment is a staged, crash-recoverable transaction,
not a falsely claimed single-operation atomic update. A private, fsynced journal covers
the controller, wrappers, deployment state, and optional launchd plist. Recovery either
restores fixed-name backups or finishes binding activation and post-activation smoke.
The Pi release directories and the `current`/`previous` release links are outside this
replacement set and remain unchanged.

## Amendment — controller revision 2, complete manifests, and local audit (2026-09-09)

Revision 2 persists the exact relative runtime path `node-current/node`; the Node member
of `npmCommand` has the same value. Consumers accept no alternative and resolve it under
the validated deployment root. Revision-1 absolute state is accepted only as migration
input. Stable wrappers resolve symlinks from `$0` and derive the deployment root from
their own physical directory, so they contain no user-home path. The private launchd
plist remains the deliberate macOS exception because launchd requires absolute program
and environment paths.

`installV3` now refreshes already-bound revision-1 deployments and revision-2 deployments
whose manifested controller sources differ from the checkout. It uses the adoption
journal to replace the controller, controller manifest, wrappers, state, and optional
launchd plist while preserving the qualified binding and both release links. Recovery is
tested by terminating a child process at `prepared`, `artifacts-installed`,
`binding-active`, and `launchd-loaded`, including dead-lock reclamation.

Release manifests cover every regular file except `critical.sha256`. npm `.bin` links,
all other symlinks, special files, duplicate paths, and control characters are refused.
An existing partial manifest is upgraded only after it still verifies and the active
release passes the compatibility qualification. Atomic rename followed by directory
`fsync` makes this single-file trust transition crash-safe. This detects corruption and
unintended drift, not a malicious process already holding the local user's authority.

Release promotion and rollback use a private journal with durable phases `prepared`,
`links-active`, `qualified`, and `state-active`. Each user-initiated mutation also writes
a bounded local audit start before mutation and an immutable result after it. Runtime
adoption journals carry the audit operation UUID so restart recovery can close the same
evidence with outcome `recovered`. If result persistence fails after an applied atomic
mutation, the command reports the real operational success with `auditComplete: false`;
read-only status exposes the incomplete evidence. Completed retention is 256 and never
automatically removes incomplete operations.

The launchd environment marks scheduled checks as `automatic`; direct controller calls
pass `manual`. This marker records provenance and is not an authorization boundary.
Administrative child processes receive only the explicit recovery allowlist and required
per-gate variables.

Outbound metadata and package sources are loaded from the manifest-covered supply-chain
policy. The default `upstream-exception` profile is explicitly `not-sovereign`; it uses
pi.dev and npm over bounded HTTPS contracts. A reviewed EU mirror can implement the same
static descriptor and npm-compatible protocol without controller changes. The Gondolin
lockfile pins the reviewed MIT `undici` override and a zero-finding production dependency
audit is a release gate.
