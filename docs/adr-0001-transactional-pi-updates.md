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
