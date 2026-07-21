import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  clearSandboxCapabilitiesForTests,
  registerSandboxCapability,
} from "../extensions/policy-gate/capabilities.mjs";
import {
  DEFAULT_MODE,
  MODES,
  canonicalizePath,
  classifyCommand,
  classifyToolCall,
  createCounters,
  decidePreflight,
  formatConfirmation,
  formatStatus,
  inspectSensitivePath,
  normalizeMode,
  recordDecision,
  redactText,
} from "../extensions/policy-gate/policy.mjs";

test("la politique démarre en observation", () => {
  assert.equal(DEFAULT_MODE, "observe");
  assert.deepEqual(MODES, ["off", "observe", "confirm", "enforce"]);
  assert.equal(normalizeMode(" CONFIRM "), "confirm");
  assert.equal(normalizeMode("invalid"), undefined);
});

test("les outils intégrés distinguent lecture, mutation et cible sensible", () => {
  const cwd = "/tmp/workspace";

  assert.equal(classifyToolCall({ toolName: "read", input: { path: "README.md" }, cwd }).risk, "R0");
  assert.equal(classifyToolCall({ toolName: "functions.read", input: { path: ".env" }, cwd }).risk, "R2");
  assert.equal(classifyToolCall({ toolName: "edit", input: { path: "src/app.ts" }, cwd }).risk, "R1");

  const gitWrite = classifyToolCall({ toolName: "write", input: { path: ".git/config" }, cwd });
  assert.equal(gitWrite.risk, "R2");
  assert.equal(gitWrite.enforceDeny, true);
  assert.ok(gitWrite.findings.some((finding) => finding.code === "git-metadata"));

  const keyWrite = classifyToolCall({ toolName: "write", input: { path: "server.key" }, cwd });
  assert.equal(keyWrite.risk, "R2");
  assert.equal(keyWrite.enforceDeny, true);
});

test("une attestation sandbox active borne bash sans allowlist regex", (t) => {
  clearSandboxCapabilitiesForTests();
  t.after(() => clearSandboxCapabilitiesForTests());
  assert.throws(() => registerSandboxCapability({
    toolName: "bash",
    backend: "unsafe",
    hostMounts: 1,
    network: "allow",
    isActive: () => true,
  }), /host-mounts-must-be-zero/);
  let active = true;
  const unregister = registerSandboxCapability({
    toolName: "bash",
    backend: "gondolin-test",
    hostMounts: 0,
    network: "deny",
    isActive: () => active,
  });

  assert.throws(() => registerSandboxCapability({
    toolName: "bash",
    backend: "second-sandbox",
    hostMounts: 0,
    network: "deny",
    isActive: () => true,
  }), /already-active/);

  // Sous sandbox, un risque nommé (git push = R3) est abaissé à R2 mais reste
  // VISIBLE — la classification n'est plus court-circuitée en R1 aveugle
  // (durcissement 2026-07-21 : cf. test/policy-gate-hardening.test.mjs).
  const sandboxed = classifyToolCall({ toolName: "bash", input: { command: "git push origin main" } });
  assert.equal(sandboxed.risk, "R2");
  assert.ok(sandboxed.findings.some((finding) => finding.code === "sandboxed-shell"));
  assert.ok(sandboxed.findings.some((finding) => finding.code === "git-push"), "le risque nommé reste visible");
  assert.equal(sandboxed.enforceDeny, false);
  assert.deepEqual(sandboxed.sandbox, { backend: "gondolin-test", hostMounts: 0, network: "deny" });

  active = false;
  assert.equal(classifyToolCall({ toolName: "bash", input: { command: "git push origin main" } }).risk, "R3");
  unregister();
});

test("les outils déclarés gardent leur niveau et les inconnus passent fail-closed", () => {
  const docs = classifyToolCall({ toolName: "query-docs", input: { query: "React hooks" } });
  const deploy = classifyToolCall({ toolName: "deploy_app", input: { environment: "prod" } });
  const unknown = classifyToolCall({ toolName: "mcp_custom_mutation", input: {} });

  assert.equal(docs.risk, "R1");
  assert.equal(deploy.risk, "R3");
  assert.equal(unknown.risk, "R2");
  assert.ok(unknown.findings.some((finding) => finding.code === "unknown-tool"));
});

test("les commandes de consultation simples sont R0", () => {
  for (const command of ["pwd", "ls -la", "cat README.md", "git status --short", "git -C repo diff --stat"]) {
    assert.equal(classifyCommand(command).risk, "R0", command);
  }
});

test("une commande shell non classifiée exige une confirmation R2", () => {
  assert.equal(classifyCommand("npm test").risk, "R2");
  assert.equal(classifyCommand("node scripts/build.mjs").risk, "R2");
  assert.equal(classifyCommand("cat README.md\nnode scripts/build.mjs").risk, "R2");
});

test("les opérations locales sensibles sont R2", () => {
  const cases = [
    ["rm file.txt", "local-delete"],
    ["sudo service restart", "privilege-escalation"],
    ["chmod 600 config", "permission-change"],
    ["git restore src/app.ts", "git-worktree-discard"],
    ["cat ~/.ssh/id_ed25519", "sensitive-path"],
    ["rg TOKEN .env.local", "sensitive-path"],
  ];

  for (const [command, reason] of cases) {
    const result = classifyCommand(command);
    assert.equal(result.risk, "R2", command);
    assert.ok(result.findings.some((finding) => finding.code === reason), command);
  }
});

test("les opérations externes ou destructives larges sont R3", () => {
  const cases = [
    ["git push origin main", "git-push", false],
    ["git -C repo push origin main", "git-push", false],
    ["git push --force origin main", "force-push", true],
    ["rm -rf build", "recursive-delete", true],
    ["git reset --hard HEAD~1", "git-reset-hard", true],
    ["git clean -fd", "git-clean-force", true],
    ["npm publish", "package-publish", false],
    ["npm unpublish fixture", "package-publish", false],
    ["docker push registry.example/image", "image-push", false],
    ["cc deploy", "deployment", false],
    ["terraform destroy -auto-approve", "infrastructure-destroy", true],
    ["curl -X POST https://example.invalid/hook", "http-mutation", false],
    ["curl -d a=b https://example.invalid/hook", "http-mutation", false],
    ["curl --json '{\"ok\":true}' https://example.invalid/hook", "http-mutation", false],
    ["curl --form-string 'a=b' https://example.invalid/hook", "http-mutation", false],
    ["glab api projects/1 -X POST -f name=x", "forge-api-mutation", false],
    ["ssh host.example uptime", "remote-shell", false],
  ];

  for (const [command, reason, deniedInEnforce] of cases) {
    const result = classifyCommand(command);
    assert.equal(result.risk, "R3", command);
    assert.equal(result.enforceDeny, deniedInEnforce, command);
    assert.ok(result.findings.some((finding) => finding.code === reason), command);
  }
});

test("les chemins non existants sont canonisés à travers leur parent symlink", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-policy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const workspace = join(root, "workspace");
  const vault = join(root, "vault");
  mkdirSync(workspace);
  mkdirSync(join(vault, ".ssh"), { recursive: true });
  symlinkSync(vault, join(workspace, "linked-vault"), "dir");

  const canonical = canonicalizePath("linked-vault/.ssh/new-key", workspace);
  const sensitive = inspectSensitivePath("linked-vault/.ssh/new-key", workspace);

  assert.equal(canonical, join(canonicalizePath(vault), ".ssh", "new-key"));
  assert.equal(sensitive?.code, "credential-directory");
});

test("un fichier symlinké vers un secret est détecté par sa cible réelle", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-policy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const workspace = join(root, "workspace");
  const vault = join(root, "vault");
  mkdirSync(workspace);
  mkdirSync(vault);
  writeFileSync(join(vault, ".env"), "FAKE_SECRET=fixture\n");
  symlinkSync(join(vault, ".env"), join(workspace, "config"));

  const result = classifyToolCall({ toolName: "read", input: { path: "config" }, cwd: workspace });

  assert.equal(result.risk, "R2");
  assert.equal(result.targets[0], canonicalizePath(join(vault, ".env")));
  assert.ok(result.findings.some((finding) => finding.code === "environment-file"));
});

test("la redaction retire les credentials des messages de confirmation", () => {
  const command = "API_TOKEN=top-secret-value curl -H 'Authorization: Basic basic-secret-value' --api-key cli-secret-value -u basic-user-secret https://user:pass@localhost";
  const redacted = redactText(command);
  const classification = classifyToolCall({ toolName: "bash", input: { command } });
  const confirmation = formatConfirmation(classification, { command });

  for (const secret of ["top-secret-value", "basic-secret-value", "cli-secret-value", "basic-user-secret", "user:pass"]) {
    assert.doesNotMatch(redacted, new RegExp(secret));
    assert.doesNotMatch(confirmation, new RegExp(secret));
  }
  assert.match(redacted, /<redacted>/);

  const email = ["person", "example.invalid"].join("@");
  const personal = redactText(`contact=${email} path=${join(homedir(), "private-project")}`);
  assert.doesNotMatch(personal, new RegExp(email.replace(".", "\\.")));
  assert.doesNotMatch(personal, new RegExp(homedir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(personal, /<email:redacted>/);
});

test("la décision préliminaire couvre observation, headless et enforcement", () => {
  const localSensitive = classifyToolCall({ toolName: "write", input: { path: ".env" } });
  const external = classifyToolCall({ toolName: "bash", input: { command: "git push origin main" } });

  assert.deepEqual(decidePreflight({ mode: "observe", classification: localSensitive, hasUI: false }), { action: "allow" });
  assert.deepEqual(decidePreflight({ mode: "confirm", classification: localSensitive, hasUI: false }), {
    action: "block",
    reason: "confirmation-unavailable",
  });
  assert.deepEqual(decidePreflight({ mode: "confirm", classification: localSensitive, hasUI: true }), { action: "confirm" });
  assert.deepEqual(decidePreflight({ mode: "enforce", classification: localSensitive, hasUI: true }), {
    action: "block",
    reason: "enforce-deny",
  });
  assert.deepEqual(decidePreflight({ mode: "enforce", classification: external, hasUI: true }), { action: "confirm" });
  assert.deepEqual(decidePreflight({ mode: "unknown", classification: external, hasUI: true }), {
    action: "block",
    reason: "invalid-mode",
  });
});

test("les compteurs ne stockent que des agrégats", () => {
  const counters = createCounters();
  const classification = classifyToolCall({
    toolName: "bash",
    input: { command: "git push origin main" },
  });

  recordDecision(counters, classification, "observed");

  assert.deepEqual(counters.seen, { R0: 0, R1: 0, R2: 0, R3: 1 });
  assert.equal(counters.observed, 1);
  assert.doesNotMatch(JSON.stringify(counters), /git|push|origin|main/);
  assert.equal(formatStatus("observe", counters), "policy: observe · R2 0 · R3 1 · bloquées 0");
});
