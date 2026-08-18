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
