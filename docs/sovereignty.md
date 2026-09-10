# Sovereignty and data-flow status

## Decision

The shipped transactional update profile is an explicit upstream exception. Its
manifest-covered policy records:

- `profile: upstream-exception`;
- `sovereigntyStatus: not-sovereign`;
- a bounded HTTPS release descriptor on `pi.dev`;
- the public npm-compatible registry as package source.

This profile must not be presented as sovereign. The repository has no evidence that
all upstream processing, operators, legal entities, or subprocessors satisfy an EU-only
control and residency boundary. GitHub-hosted CI is subject to the same limitation.

## Data flow and privacy boundary

Update requests send package coordinates and release metadata to the configured
descriptor and registry. They do not send prompts, provider credentials, project file
contents, local commands, usernames, or Home paths. Network peers still receive IP and
transport metadata. A regulated deployment therefore requires a reviewed DPA, retention
policy, subprocessor inventory, and transfer assessment for the selected upstreams.

Administrative child processes receive a constructed environment containing only
`HOME`, a fixed executable `PATH`, the private deployment `TMPDIR`, the deployment root,
offline qualification state, and gate-specific `PI_GONDOLIN_*` values. Provider keys,
proxy variables, `NODE_OPTIONS`, `NODE_PATH`, caller npm configuration, and project
variables are not inherited.

The local audit stores only strict enums, random operation identifiers, ISO-8601
timestamps, release or binding identifiers, outcomes, and sanitized stable error codes.
It never stores the absolute launchd paths, `HOME`, prompts, credentials, commands, or
project paths. Evidence remains on the local machine. Completed retention is 256;
incomplete crash evidence is never automatically deleted. Removing the deployment is
the deletion procedure.

## Compatible sovereign target

The controller contracts do not require a new SaaS dependency. A reviewed EU-operated
profile can retain the same interfaces:

1. publish the small static JSON release descriptor from Clever Cloud Cellar in an EU
   region;
2. mirror the exact npm artifacts and integrity metadata in an EU-operated GitLab
   Package Registry or Harbor-compatible distribution layer;
3. replace both URLs only through the reviewed, manifest-covered
   `supply-chain-policy.json`;
4. preserve exact versions, integrity checks, lifecycle-script refusal, license audit,
   complete manifests, and Gondolin qualification;
5. record evidence for EU residency, operator, legal entity, subprocessors, retention,
   and incident response before changing `sovereigntyStatus`.

Protocol compatibility is not proof of sovereignty. The status may change only after
the infrastructure and its evidence satisfy all of those criteria.

## License and dependency policy

Accepted runtime licenses are permissive or weak-copyleft licenses explicitly listed by
the controller (including MIT, Apache-2.0, BSD, ISC, MPL-2.0, and reviewed equivalents).
AGPL, SSPL, forbidden, missing, or unknown licenses fail closed. The narrow historical
`tweetnacl@0.14.5` exception is bound to the Gondolin version and recorded hashes; it is
not a general Unlicense allowance.

The Gondolin lockfile pins `undici` 6.28.1 under MIT. Completion requires
`npm audit --omit=dev` to report zero known production vulnerabilities. Automated
`npm audit fix` is prohibited because it can mutate unrelated transitive versions
without the repository's qualification evidence.

## Non-applicable controls

This component is a local, single-user CLI and exposes no inbound HTTP API. Tenant
isolation, Biscuit authorization, pagination, and API response envelopes are therefore
not applicable. The relevant controls are local ownership and mode checks, fail-closed
path resolution, bounded outbound responses, exact source policy, no-PII logs, private
audit evidence, and crash recovery.
