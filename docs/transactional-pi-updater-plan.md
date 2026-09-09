# Transactional Pi updater plan

## Decision

Replace the version-locked in-place Gondolin deployment with versioned Pi releases and a stable controller. A candidate is activated only after compatibility and security gates pass. A changed hash is never accepted as compatibility evidence by itself.

## Invariants

- Direct `pi --mode rpc` and direct `rpc-entry.js` remain refused.
- The supported RPC entry remains `pi-gondolin-rpc` with an explicit snapshot root and exact relative allowlist.
- Gondolin keeps zero host mounts, denied guest egress, no host-shell fallback, bounded prompts, bounded tool calls, and a bounded session.
- No candidate mutates the active release before qualification succeeds.
- Activation and rollback change symlinks atomically.
- The previous qualified release remains available after activation.
- Runtime files are copied into the owned deployment directory; deployed execution never depends on a source checkout.
- Logs and status contain versions, hashes, gate names, and aggregate outcomes only—never prompts, commands, raw paths, secrets, or provider content.
- A package-name change, missing integrity metadata, unsupported layout, failed gate, or controller error is fail-closed.

## Layout

```text
~/.local/share/pi-harness-challenger/gondolin-rpc/
├── controller/
│   ├── update-local.mjs
│   └── runtime/...
├── releases/
│   └── <version>-<package-hash>/
│       ├── node_modules/@earendil-works/pi-coding-agent/...
│       ├── package-lock.json
│       ├── release.json
│       └── critical.sha256
├── current -> releases/<qualified-release>
├── previous -> releases/<previous-qualified-release>
├── deployment.json
├── pi
└── pi-gondolin-rpc
```

## Command routing

- `pi update`, `pi update pi`, `pi update self`, `pi update --self`, and `pi update --all` route through the transactional updater.
- `pi update --models`, `pi update --extensions`, and a single extension source delegate to the active Pi because they do not replace the active Pi package.
- `pi-gondolin-rpc` validates the active release and copied runtime before starting the fixed launcher.
- Direct RPC through `pi` remains refused unless it comes from the attested launcher process.

## Implementation sequence

1. Extract pure update-target classification, manifest validation, release naming, and atomic-link helpers.
2. Add tests first for target routing, unsafe paths, package metadata, locks, failed qualification, activation, and rollback under an isolated HOME.
3. Stage packages with npm under a private candidate directory using `--ignore-scripts`, exact version, and registry integrity metadata.
4. Guard the candidate `rpc-entry.js`, preserve its original bytes inside the candidate, and hash all security-critical candidate/runtime files.
5. Run candidate gates without changing `current`: CLI/version smoke, direct RPC refusal, fixed launcher protocol refusal, budgets, and no-host-write RPC E2E.
6. Atomically move the qualified candidate into `releases/`, switch `previous`, then switch `current`.
7. Run a post-activation smoke and automatically restore `current` on failure.
8. Migrate the active v2 deployment to v3 while preserving a rollback snapshot.
9. Update package scripts and documentation.
10. Run unit, focused deployment, Gondolin E2E, full `npm run check`, coverage, and a solo security review before activating globally.

## Compatibility policy

Automatic promotion is allowed only when all existing gates pass unchanged. The updater does not synthesize code changes for a new Pi API. An incompatible release remains unactivated with a static aggregate refusal code. Supporting it requires a reviewed harness change and a new green qualification.

## Rollback

Before activation, rollback means deleting only the private candidate. After activation, rollback atomically restores `current` from `previous`. Migration retains the original v2 state and original Pi package until the v3 post-activation smoke passes.

## Acceptance

- A compatible fixture release is staged, qualified, activated, and reported without exposing sensitive data.
- An incompatible fixture release cannot alter `current` or `previous`.
- Concurrent updates are refused by an owned lock.
- A failed post-activation smoke restores the previous release.
- `pi update --models` and `--extensions` bypass self-update staging.
- Direct RPC remains refused; `pi-gondolin-rpc` passes the existing no-host-write E2E.
- Removing the source checkout does not affect the deployed runtime.
