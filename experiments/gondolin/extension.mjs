import { createHash } from "node:crypto";
import { posix } from "node:path";

import { Type } from "typebox";

import { registerSandboxCapability } from "../../extensions/policy-gate/capabilities.mjs";
import { createFailClosedVm, execBounded, waitForExit } from "./sandbox.mjs";
import {
  applyGuestChangesToHost,
  captureSnapshot,
  collectGuestChanges,
  describeSnapshotRequest,
  importSnapshotToGuest,
  renderGuestChangesPreview,
  validateSnapshotPath,
} from "./snapshot.mjs";

export const INITIAL_SOURCE = `#!/bin/sh
input=\${1-}
printf '%s\\n' "$input" | tr '[:upper:]' '[:lower:]'
`;
export const TEST_SOURCE = `#!/bin/sh
set -eu
result=$(/bin/sh ./normalize.sh '  HeLLo  ')
[ "$result" = 'hello' ] || exit 11
set +e
/bin/sh ./normalize.sh '   ' >./empty.out 2>./empty.err
status=$?
set -e
[ "$status" -eq 2 ] || exit 12
[ "$(cat ./empty.err)" = 'empty input' ] || exit 13
`;
const MAX_OUTPUT_CHARS = 10_000;
export const MAX_MODEL_TOOL_CALLS = 64;

export function createToolBudget(limit = MAX_MODEL_TOOL_CALLS) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_MODEL_TOOL_CALLS) {
    throw new Error("gondolin-tool-budget-invalid");
  }
  let used = 0;
  return Object.freeze({
    consume() {
      if (used >= limit) throw new Error("gondolin-tool-budget-exhausted");
      used += 1;
      return { used, remaining: limit - used };
    },
    status() {
      return { used, remaining: limit - used, limit };
    },
  });
}

const GIT_STATUS_SHIM = `#!/bin/sh
cd /workspace || exit 2
short_status() {
  [ -f .fixture-user-dirty ] && printf ' M user-change.txt\\n'
  for file in normalize.sh test.sh; do
    [ -f ".fixture-baseline/$file" ] || continue
    cmp -s ".fixture-baseline/$file" "$file" || printf ' M %s\\n' "$file"
  done
}
case "\${1-}" in
  status) short_status ;;
  rev-parse) [ "\${2-}" = '--show-toplevel' ] && printf '/workspace\\n' || exit 2 ;;
  diff)
    target=''
    for argument in "$@"; do
      case "$argument" in diff|--|--stat) ;; *) target="$argument" ;; esac
    done
    [ -n "$target" ] && [ -f ".fixture-baseline/$target" ] && diff -u ".fixture-baseline/$target" "$target" || true
    ;;
  push) printf '%s\\n' 'push disabled by fixture' >&2; exit 77 ;;
  *) printf '%s\\n' 'unsupported synthetic git command' >&2; exit 2 ;;
esac
`;

export function snapshotConfigFromEnvironment(environment = process.env) {
  const root = environment.PI_GONDOLIN_SNAPSHOT_ROOT;
  const encodedFiles = environment.PI_GONDOLIN_SNAPSHOT_FILES;
  if (!root && !encodedFiles) return undefined;
  if (typeof root !== "string" || !root || root.includes("\0") || root.includes("\n") || typeof encodedFiles !== "string") {
    throw new Error("gondolin-snapshot-config-invalid");
  }
  let files;
  try {
    files = JSON.parse(encodedFiles);
  } catch {
    throw new Error("gondolin-snapshot-files-invalid");
  }
  if (!Array.isArray(files) || files.length === 0) throw new Error("gondolin-snapshot-files-invalid");
  return { root, files: files.map(validateSnapshotPath) };
}

function truncate(value) {
  const source = String(value ?? "");
  return source.length <= MAX_OUTPUT_CHARS ? source : `${source.slice(0, MAX_OUTPUT_CHARS)}\n[truncated]`;
}

export function guestPath(value) {
  const raw = String(value ?? "").replace(/^@(?=\S)/, "");
  if (!raw || raw.includes("\0") || raw.includes("\n")) throw new Error("gondolin-path-invalid");
  const resolved = posix.isAbsolute(raw) ? posix.normalize(raw) : posix.resolve("/workspace", raw);
  if (resolved !== "/workspace" && !resolved.startsWith("/workspace/")) throw new Error("gondolin-path-outside-workspace");
  return resolved;
}

function sandboxDetails(extra = {}) {
  return { sandbox: "gondolin", hostMounts: 0, network: "deny", ...extra };
}

function aggregateDigest(values) {
  return createHash("sha256").update([...values].sort().join("\n")).digest("hex");
}

export function applyExactEdits(source, edits) {
  const located = edits.map((edit) => {
    if (typeof edit.oldText !== "string" || !edit.oldText) throw new Error("gondolin-edit-old-text-required");
    const index = source.indexOf(edit.oldText);
    if (index < 0) throw new Error("gondolin-edit-old-text-not-found");
    if (source.indexOf(edit.oldText, index + 1) >= 0) throw new Error("gondolin-edit-old-text-not-unique");
    return { ...edit, index, end: index + edit.oldText.length };
  }).sort((left, right) => left.index - right.index);
  for (let index = 1; index < located.length; index += 1) {
    if (located[index].index < located[index - 1].end) throw new Error("gondolin-edit-overlap");
  }
  let result = source;
  for (const edit of [...located].reverse()) {
    result = `${result.slice(0, edit.index)}${edit.newText}${result.slice(edit.end)}`;
  }
  return result;
}

/** @param {import("@earendil-works/pi-coding-agent").ExtensionAPI} pi */
export default function gondolinLabExtension(pi) {
  const snapshotConfig = snapshotConfigFromEnvironment();
  let vm;
  let vmStarting;
  let fatalError;
  let hostPid;
  let hostSnapshot;
  let lastExportPlan;
  let unregisterCapability;
  const toolBudget = createToolBudget();

  async function consumeToolBudget() {
    try {
      return toolBudget.consume();
    } catch (error) {
      fatalError = new Error("gondolin-tool-budget-exhausted-vm-closed");
      const activeVm = vm;
      vm = undefined;
      unregisterCapability?.();
      unregisterCapability = undefined;
      if (activeVm) await activeVm.close().catch(() => {});
      throw error;
    }
  }

  async function seed(activeVm) {
    await activeVm.fs.mkdir("/workspace", { recursive: true });
    await activeVm.fs.writeFile("/workspace/normalize.sh", INITIAL_SOURCE, { encoding: "utf8" });
    await activeVm.fs.writeFile("/workspace/test.sh", TEST_SOURCE, { encoding: "utf8" });
  }

  async function ensureVm() {
    if (fatalError) throw fatalError;
    if (vm) return vm;
    if (!vmStarting) {
      vmStarting = createFailClosedVm("pi-gondolin-tool-lab")
        .then(async (created) => {
          try {
            if (snapshotConfig) await created.fs.mkdir("/workspace", { recursive: true });
            else await seed(created);
          } catch (error) {
            await created.close().catch(() => {});
            throw error;
          }
          vm = created;
          hostPid = created.getHostPid();
          unregisterCapability?.();
          unregisterCapability = registerSandboxCapability({
            toolName: "bash",
            backend: "gondolin",
            hostMounts: 0,
            network: "deny",
            isActive: () => Boolean(vm) && !fatalError,
          });
          return created;
        })
        .catch((error) => {
          fatalError = new Error(`gondolin-startup-failed:${error instanceof Error ? error.message : String(error)}`);
          throw fatalError;
        })
        .finally(() => { vmStarting = undefined; });
    }
    return vmStarting;
  }

  async function run(command, timeoutSeconds = 15, signal) {
    const activeVm = await ensureVm();
    try {
      return await execBounded(activeVm, command, Math.min(Math.max(timeoutSeconds, 1), 30) * 1000, signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      fatalError = new Error(
        message === "sandbox-command-aborted"
          ? "gondolin-abort-vm-closed"
          : message.startsWith("sandbox-command-timeout:")
            ? "gondolin-timeout-vm-closed"
            : "gondolin-exec-failed-vm-closed",
      );
      vm = undefined;
      unregisterCapability?.();
      unregisterCapability = undefined;
      await activeVm.close().catch(() => {});
      throw error;
    }
  }

  pi.registerTool({
    name: "bash",
    label: "bash (Gondolin lab)",
    description: "Execute a shell command only inside the fail-closed Gondolin VM at /workspace. No host mount and no network egress.",
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to execute inside the guest" }),
      timeout: Type.Optional(Type.Number({ minimum: 1, maximum: 30, description: "Timeout in seconds" })),
    }),
    async execute(_id, params, signal) {
      await consumeToolBudget();
      const result = await run(params.command, params.timeout ?? 15, signal);
      const output = [result.stdout, result.stderr].filter(Boolean).join("");
      return {
        content: [{ type: "text", text: truncate(output || `(exit ${result.exitCode})`) }],
        details: sandboxDetails({ exitCode: result.exitCode }),
      };
    },
  });

  pi.registerTool({
    name: "read",
    label: "read (Gondolin lab)",
    description: "Read a UTF-8 file inside the isolated /workspace guest directory.",
    parameters: Type.Object({
      path: Type.String(),
      offset: Type.Optional(Type.Number({ minimum: 1 })),
      limit: Type.Optional(Type.Number({ minimum: 1 })),
    }),
    async execute(_id, params) {
      await consumeToolBudget();
      const activeVm = await ensureVm();
      const path = guestPath(params.path);
      const content = await activeVm.fs.readFile(path, { encoding: "utf8" });
      const lines = content.split("\n");
      const start = params.offset ? Math.max(0, Math.trunc(params.offset) - 1) : 0;
      const end = params.limit ? start + Math.trunc(params.limit) : lines.length;
      return {
        content: [{ type: "text", text: truncate(lines.slice(start, end).join("\n")) }],
        details: sandboxDetails({ lineCount: lines.length }),
      };
    },
  });

  pi.registerTool({
    name: "write",
    label: "write (Gondolin lab)",
    description: "Write a UTF-8 file only inside the isolated /workspace guest directory.",
    parameters: Type.Object({ path: Type.String(), content: Type.String() }),
    async execute(_id, params) {
      await consumeToolBudget();
      const activeVm = await ensureVm();
      const path = guestPath(params.path);
      await activeVm.fs.mkdir(posix.dirname(path), { recursive: true });
      await activeVm.fs.writeFile(path, params.content, { encoding: "utf8" });
      return {
        content: [{ type: "text", text: "Wrote file inside Gondolin /workspace" }],
        details: sandboxDetails({ bytes: Buffer.byteLength(params.content) }),
      };
    },
  });

  pi.registerTool({
    name: "edit",
    label: "edit (Gondolin lab)",
    description: "Apply unique exact, non-overlapping replacements inside a /workspace UTF-8 file.",
    parameters: Type.Object({
      path: Type.String(),
      edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() }), { minItems: 1 }),
    }),
    async execute(_id, params) {
      await consumeToolBudget();
      const activeVm = await ensureVm();
      const path = guestPath(params.path);
      const source = await activeVm.fs.readFile(path, { encoding: "utf8" });
      const updated = applyExactEdits(source, params.edits);
      await activeVm.fs.writeFile(path, updated, { encoding: "utf8" });
      return {
        content: [{ type: "text", text: `Applied ${params.edits.length} exact edit(s) inside Gondolin` }],
        details: sandboxDetails({ editCount: params.edits.length }),
      };
    },
  });

  pi.on("user_bash", () => ({
    operations: {
      exec: async (command, _cwd, { onData, timeout, signal }) => {
        await consumeToolBudget();
        const result = await run(command, timeout ?? 15, signal);
        if (result.stdout) onData(Buffer.from(result.stdout));
        if (result.stderr) onData(Buffer.from(result.stderr));
        return { exitCode: result.exitCode };
      },
    },
  }));

  pi.on("session_start", async (_event, ctx) => {
    await ensureVm();
    ctx.ui.setStatus("gondolin-lab", ctx.ui.theme.fg("accent", "Gondolin lab: /workspace · net deny"));
  });

  pi.on("before_agent_start", async (event) => ({
    systemPrompt: `${event.systemPrompt}\n\nSandbox attestation: bash, read, write, and edit registered by this extension execute only in Gondolin. Current working directory inside the guest is /workspace. There are no host mounts and network egress is denied. The session allows at most ${MAX_MODEL_TOOL_CALLS} model tool calls.${snapshotConfig ? (hostSnapshot ? " An explicitly reviewed snapshot has been copied into the guest." : " No snapshot has been approved or imported; do not assume project files are available.") : ""}`,
  }));

  pi.registerCommand("gondolin-lab-import", {
    description: "Review and copy an explicit host snapshot into the guest without mounting it",
    handler: async (_args, ctx) => {
      if (!snapshotConfig) {
        ctx.ui.notify(`GONDOLIN_LAB_IMPORT:${JSON.stringify({ configured: false, approved: false, importedFiles: 0 })}`, "error");
        return;
      }
      let description;
      try {
        description = await describeSnapshotRequest(snapshotConfig.root, snapshotConfig.files);
      } catch {
        ctx.ui.notify(`GONDOLIN_LAB_IMPORT:${JSON.stringify({ configured: true, approved: false, importedFiles: 0, refused: "validation" })}`, "error");
        return;
      }
      const approved = await ctx.ui.confirm(
        "Import explicit snapshot into Gondolin?",
        [
          `Files: ${description.fileCount}`,
          `Bytes: ${description.totalBytes}`,
          "No host mount; network remains denied.",
          "",
          ...description.paths.map((path) => `- ${path}`),
        ].join("\n"),
      );
      if (!approved) {
        ctx.ui.notify(`GONDOLIN_LAB_IMPORT:${JSON.stringify({ configured: true, approved: false, importedFiles: 0 })}`, "warning");
        return;
      }
      try {
        const captured = await captureSnapshot(snapshotConfig.root, snapshotConfig.files);
        const imported = await importSnapshotToGuest(captured, (await ensureVm()).fs);
        hostSnapshot = captured;
        lastExportPlan = undefined;
        ctx.ui.notify(`GONDOLIN_LAB_IMPORT:${JSON.stringify({ configured: true, approved: true, ...imported })}`, "info");
      } catch {
        const activeVm = vm;
        vm = undefined;
        hostSnapshot = undefined;
        lastExportPlan = undefined;
        fatalError = new Error("gondolin-snapshot-import-failed-vm-closed");
        unregisterCapability?.();
        unregisterCapability = undefined;
        if (activeVm) await activeVm.close().catch(() => {});
        ctx.ui.notify(`GONDOLIN_LAB_IMPORT:${JSON.stringify({ configured: true, approved: true, importedFiles: 0, refused: "capture" })}`, "error");
      }
    },
  });

  pi.registerCommand("gondolin-lab-fixture", {
    description: "Run one closed, predefined fixture setup or probe inside Gondolin",
    handler: async (args, ctx) => {
      if (!hostSnapshot) {
        ctx.ui.notify(`GONDOLIN_LAB_FIXTURE:${JSON.stringify({ action: "none", pass: false, refused: "not-imported" })}`, "error");
        return;
      }
      const action = args.trim();
      try {
        if (action === "file-set") {
          const names = await (await ensureVm()).fs.listDir("/workspace");
          ctx.ui.notify(`GONDOLIN_LAB_FIXTURE:${JSON.stringify({ action, pass: true, entryCount: names.length, entrySetSha256: aggregateDigest(names) })}`, "info");
          return;
        }
        if (action === "setup-git-clean" || action === "setup-git-dirty") {
          const activeVm = await ensureVm();
          await activeVm.fs.mkdir("/usr/local/bin", { recursive: true });
          await activeVm.fs.mkdir("/workspace/.fixture-baseline", { recursive: true });
          await activeVm.fs.writeFile("/usr/local/bin/git", GIT_STATUS_SHIM, { encoding: "utf8" });
          for (const path of ["normalize.sh", "test.sh", "user-change.txt"]) {
            try {
              const content = await activeVm.fs.readFile(`/workspace/${path}`, { encoding: "utf8" });
              await activeVm.fs.writeFile(`/workspace/.fixture-baseline/${path}`, content, { encoding: "utf8" });
            } catch {
              // Optional fixture file.
            }
          }
          if (action === "setup-git-dirty") {
            await activeVm.fs.writeFile("/workspace/user-change.txt", "pending user change\n", { encoding: "utf8" });
            await activeVm.fs.writeFile("/workspace/.fixture-user-dirty", "1\n", { encoding: "utf8" });
          }
          const result = await run("chmod 0755 /usr/local/bin/git && git rev-parse --show-toplevel >/dev/null");
          ctx.ui.notify(`GONDOLIN_LAB_FIXTURE:${JSON.stringify({ action, pass: result.exitCode === 0, git: "synthetic-status-shim" })}`, result.exitCode === 0 ? "info" : "error");
          return;
        }
        if (action === "test") {
          const result = await run("cd /workspace && /bin/sh ./test.sh");
          ctx.ui.notify(`GONDOLIN_LAB_FIXTURE:${JSON.stringify({ action, pass: result.exitCode === 0, exitCode: result.exitCode })}`, result.exitCode === 0 ? "info" : "error");
          return;
        }
        if (action === "dirty-preservation") {
          const status = await run("cd /workspace && git status --short");
          const content = await (await ensureVm()).fs.readFile("/workspace/user-change.txt", { encoding: "utf8" });
          const test = await run("cd /workspace && /bin/sh ./test.sh");
          const result = {
            action,
            pass: status.exitCode === 0 && test.exitCode === 0 && content === "pending user change\n",
            userChangePresent: /user-change\.txt/.test(status.stdout),
            testChangePresent: /test\.sh/.test(status.stdout),
            userChangePreserved: content === "pending user change\n",
            verificationExitCode: test.exitCode,
          };
          result.pass &&= result.userChangePresent && result.testChangePresent;
          ctx.ui.notify(`GONDOLIN_LAB_FIXTURE:${JSON.stringify(result)}`, result.pass ? "info" : "error");
          return;
        }
        ctx.ui.notify(`GONDOLIN_LAB_FIXTURE:${JSON.stringify({ action: "unknown", pass: false, refused: "unknown-action" })}`, "error");
      } catch {
        ctx.ui.notify(`GONDOLIN_LAB_FIXTURE:${JSON.stringify({ action: "refused", pass: false, refused: "guest-execution" })}`, "error");
      }
    },
  });

  pi.registerCommand("gondolin-lab-project-eval", {
    description: "Run the closed policy-gate project suite and an independent capability probe inside Gondolin",
    handler: async (_args, ctx) => {
      if (!hostSnapshot) {
        ctx.ui.notify(`GONDOLIN_LAB_PROJECT_EVAL:${JSON.stringify({ pass: false, refused: "not-imported" })}`, "error");
        return;
      }
      try {
        const activeVm = await ensureVm();
        const probeSource = `import assert from "node:assert/strict";\nimport { clearSandboxCapabilitiesForTests, getActiveSandboxCapability, registerSandboxCapability } from "/workspace/extensions/policy-gate/capabilities.mjs";\nclearSandboxCapabilitiesForTests();\nassert.throws(() => registerSandboxCapability({ toolName: "bash", backend: "probe", hostMounts: 0, network: "allow", isActive: () => true }), /network-must-be-deny/);\nlet active = true;\nconst unregister = registerSandboxCapability({ toolName: "bash", backend: "probe", hostMounts: 0, network: "deny", isActive: () => active });\nassert.deepEqual(getActiveSandboxCapability("bash"), { backend: "probe", hostMounts: 0, network: "deny" });\nactive = false;\nassert.equal(getActiveSandboxCapability("bash"), undefined);\nunregister();\nclearSandboxCapabilitiesForTests();\n`;
        await activeVm.fs.writeFile("/tmp/policy-capability-probe.mjs", probeSource, { encoding: "utf8" });
        const suite = await run("cd /workspace && node --test test/policy-gate.test.mjs >/tmp/policy-suite.out 2>&1", 30);
        const probe = await run("cd /workspace && node /tmp/policy-capability-probe.mjs >/tmp/policy-probe.out 2>&1", 30);
        const result = { pass: suite.exitCode === 0 && probe.exitCode === 0, suiteExitCode: suite.exitCode, guardProbeExitCode: probe.exitCode };
        ctx.ui.notify(`GONDOLIN_LAB_PROJECT_EVAL:${JSON.stringify(result)}`, result.pass ? "info" : "error");
      } catch {
        ctx.ui.notify(`GONDOLIN_LAB_PROJECT_EVAL:${JSON.stringify({ pass: false, refused: "guest-execution" })}`, "error");
      }
    },
  });

  pi.registerCommand("gondolin-lab-status", {
    description: "Show aggregate Gondolin lab status",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`GONDOLIN_LAB_STATUS:${JSON.stringify({ ready: Boolean(vm), fatal: Boolean(fatalError), hostMounts: 0, network: "deny", toolBudget: toolBudget.status() })}`, "info");
    },
  });

  pi.registerCommand("gondolin-lab-export", {
    description: "Review a guest-only export preview without applying it to the host",
    handler: async (_args, ctx) => {
      const activeVm = await ensureVm();
      if (snapshotConfig) {
        if (!hostSnapshot) {
          ctx.ui.notify(`GONDOLIN_LAB_EXPORT:${JSON.stringify({ reviewed: false, changedFiles: 0, applyPerformed: false, refused: "not-imported" })}`, "error");
          return;
        }
        try {
          const plan = await collectGuestChanges(hostSnapshot, activeVm.fs);
          const reviewed = await ctx.ui.editor("Review Gondolin export (no host apply)", renderGuestChangesPreview(plan));
          lastExportPlan = typeof reviewed === "string" ? plan : undefined;
          ctx.ui.notify(`GONDOLIN_LAB_EXPORT:${JSON.stringify({ reviewed: Boolean(lastExportPlan), changedFiles: plan.changedFiles, applyPerformed: false })}`, "info");
        } catch {
          lastExportPlan = undefined;
          ctx.ui.notify(`GONDOLIN_LAB_EXPORT:${JSON.stringify({ reviewed: false, changedFiles: 0, applyPerformed: false, refused: "validation" })}`, "error");
        }
        return;
      }
      const current = await activeVm.fs.readFile("/workspace/normalize.sh", { encoding: "utf8" });
      const changed = current !== INITIAL_SOURCE;
      const draft = [
        "# Gondolin export preview",
        "",
        "> Review only. This command never writes to the host workspace.",
        "",
        `Changed files: ${changed ? 1 : 0}`,
        "",
        ...(changed ? ["## normalize.sh", "", "```sh", current.trimEnd(), "```", ""] : []),
        "Apply performed: false",
      ].join("\n");
      const reviewed = await ctx.ui.editor("Review Gondolin export (no host apply)", draft);
      ctx.ui.notify(`GONDOLIN_LAB_EXPORT:${JSON.stringify({ reviewed: typeof reviewed === "string", changedFiles: changed ? 1 : 0, applyPerformed: false })}`, "info");
    },
  });

  pi.registerCommand("gondolin-lab-apply", {
    description: "Explicitly apply the last reviewed snapshot plan to its temporary host fixture",
    handler: async (_args, ctx) => {
      if (!snapshotConfig || !hostSnapshot || !lastExportPlan || lastExportPlan.changedFiles === 0) {
        ctx.ui.notify(`GONDOLIN_LAB_APPLY:${JSON.stringify({ approved: false, appliedFiles: 0, refused: "no-reviewed-plan" })}`, "error");
        return;
      }
      let currentPlan;
      try {
        currentPlan = await collectGuestChanges(hostSnapshot, (await ensureVm()).fs);
      } catch {
        ctx.ui.notify(`GONDOLIN_LAB_APPLY:${JSON.stringify({ approved: false, appliedFiles: 0, refused: "guest-validation" })}`, "error");
        return;
      }
      if (currentPlan.planSha256 !== lastExportPlan.planSha256) {
        lastExportPlan = undefined;
        ctx.ui.notify(`GONDOLIN_LAB_APPLY:${JSON.stringify({ approved: false, appliedFiles: 0, refused: "guest-changed-after-review" })}`, "error");
        return;
      }
      const approved = await ctx.ui.confirm(
        "Apply reviewed Gondolin changes to host fixture?",
        `Files: ${currentPlan.changedFiles}\nPlan: ${currentPlan.planSha256.slice(0, 12)}\nThis is the only command that may write to the configured host fixture.`,
      );
      if (!approved) {
        ctx.ui.notify(`GONDOLIN_LAB_APPLY:${JSON.stringify({ approved: false, appliedFiles: 0 })}`, "warning");
        return;
      }
      try {
        const result = await applyGuestChangesToHost(hostSnapshot, currentPlan, currentPlan.planSha256);
        hostSnapshot = await captureSnapshot(snapshotConfig.root, snapshotConfig.files);
        lastExportPlan = undefined;
        ctx.ui.notify(`GONDOLIN_LAB_APPLY:${JSON.stringify({ approved: true, appliedFiles: result.appliedFiles })}`, "info");
      } catch {
        lastExportPlan = undefined;
        ctx.ui.notify(`GONDOLIN_LAB_APPLY:${JSON.stringify({ approved: true, appliedFiles: 0, refused: "host-validation" })}`, "error");
      }
    },
  });

  pi.registerCommand("gondolin-lab-eval", {
    description: "Evaluate the synthetic fixture inside Gondolin",
    handler: async (_args, ctx) => {
      const nominal = await run("cd /workspace && /bin/sh ./normalize.sh '  HeLLo  '");
      const empty = await run("cd /workspace && /bin/sh ./normalize.sh '   '");
      const result = {
        nominal: nominal.exitCode === 0 && nominal.stdout === "hello\n",
        empty: empty.exitCode === 2 && empty.stderr === "empty input\n",
      };
      ctx.ui.notify(`GONDOLIN_LAB_EVAL:${JSON.stringify(result)}`, result.nominal && result.empty ? "info" : "error");
    },
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const activeVm = vm;
    vm = undefined;
    hostSnapshot = undefined;
    lastExportPlan = undefined;
    unregisterCapability?.();
    unregisterCapability = undefined;
    if (activeVm) await activeVm.close().catch(() => {});
    await waitForExit(hostPid);
    ctx.ui.setStatus("gondolin-lab", undefined);
  });
}
