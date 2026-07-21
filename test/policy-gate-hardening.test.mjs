import assert from "node:assert/strict";
import test from "node:test";

import {
  clearSandboxCapabilitiesForTests,
  getActiveSandboxCapability,
  registerSandboxCapability,
} from "../extensions/policy-gate/capabilities.mjs";
import { RISK_LEVELS, classifyCommand, classifyToolCall } from "../extensions/policy-gate/policy.mjs";

// --- P1-#3: patterns R3 manquants (destruction hors `rm`) ---
// Régression du challenge 2026-07-21 : find -delete, interpréteurs -c/-e et
// troncature tombaient en R2 "generic-shell" au lieu d'être signalés au niveau réel.

test("find -delete et find -exec rm sont classés R3", () => {
  const del = classifyCommand("find . -atime +90 -delete");
  assert.equal(del.risk, "R3");
  assert.ok(del.findings.some((f) => f.code === "find-destructive"));

  const exec = classifyCommand("find . -name '*.tmp' -exec rm {} +");
  assert.equal(exec.risk, "R3");
  assert.ok(exec.findings.some((f) => f.code === "find-destructive"));
});

test("les interpréteurs à code inline sont R3 (exécution opaque, non classifiable statiquement)", () => {
  for (const cmd of [
    "python3 -c 'import shutil; shutil.rmtree(\"/x\")'",
    "node -e 'require(\"fs\").rmSync(\"/x\",{recursive:true})'",
    "perl -e 'unlink glob(\"*\")'",
    "bash -c 'rm -rf /'",
  ]) {
    const r = classifyCommand(cmd);
    assert.equal(r.risk, "R3", `attendu R3 pour: ${cmd}`);
    assert.ok(r.findings.some((f) => f.code === "opaque-execution"), `finding opaque-execution manquant pour: ${cmd}`);
  }
});

test("l'exécution opaque est signalée mais pas hard-deny (évite les faux positifs benins)", () => {
  // python3 -c 'print(1)' est inoffensif : R3 pour visibilité, mais enforceDeny=false
  // pour ne pas bloquer durement en mode enforce (le mode confirme au lieu de refuser).
  const benign = classifyCommand("python3 -c 'print(1)'");
  assert.equal(benign.risk, "R3");
  assert.equal(benign.enforceDeny, false);
});

test("truncate destructif est classé R3", () => {
  const r = classifyCommand("truncate -s 0 important.db");
  assert.equal(r.risk, "R3");
  assert.ok(r.findings.some((f) => f.code === "truncate-data"));
});

test("les commandes de lecture reconnues restent R0 malgré les nouveaux patterns", () => {
  assert.equal(classifyCommand("git status").risk, "R0");
  assert.equal(classifyCommand("ls -la src").risk, "R0");
  assert.equal(classifyCommand("cat README.md").risk, "R0");
});

// --- P0-#1: sous sandbox, préserver la classification, abaisser R3→R2 (pas R1 aveugle) ---

test("sous sandbox, une commande destructive garde sa classification abaissée à R2", (t) => {
  clearSandboxCapabilitiesForTests();
  t.after(() => clearSandboxCapabilitiesForTests());
  registerSandboxCapability({
    toolName: "bash",
    backend: "gondolin-test",
    hostMounts: 0,
    network: "deny",
    isActive: () => true,
  });

  const r = classifyToolCall({ toolName: "bash", input: { command: "rm -rf /" } });
  // Contenu dans la VM → gravité réduite, MAIS le finding reste visible et le
  // niveau reste R2 (confirmé en mode confirm), pas R1 silencieux.
  assert.equal(r.risk, "R2");
  assert.ok(r.findings.some((f) => f.code === "recursive-delete"), "le finding destructif doit rester visible");
  assert.ok(r.findings.some((f) => f.code === "sandboxed-shell"), "le contexte sandbox doit être annoté");
  assert.equal(r.enforceDeny, false, "contenu par la VM → pas de hard-deny");
});

test("sous sandbox, une commande bénigne reste R1", (t) => {
  clearSandboxCapabilitiesForTests();
  t.after(() => clearSandboxCapabilitiesForTests());
  registerSandboxCapability({
    toolName: "bash",
    backend: "gondolin-test",
    hostMounts: 0,
    network: "deny",
    isActive: () => true,
  });
  const r = classifyToolCall({ toolName: "bash", input: { command: "mkdir -p build" } });
  assert.ok(RISK_LEVELS[r.risk] <= RISK_LEVELS.R1, `attendu <= R1, obtenu ${r.risk}`);
});

// --- P0-#2 + P1-#4: fraîcheur d'attestation (TTL) ---

test("une attestation expirée n'est plus active (TTL)", (t) => {
  clearSandboxCapabilitiesForTests();
  t.after(() => clearSandboxCapabilitiesForTests());
  let now = 1000;
  registerSandboxCapability({
    toolName: "bash",
    backend: "gondolin-test",
    hostMounts: 0,
    network: "deny",
    isActive: () => true,
    ttlMs: 500,
    now: () => now,
  });

  assert.ok(getActiveSandboxCapability("bash"), "active dans la fenêtre TTL");
  now = 1600; // 600 ms écoulés > 500 ms TTL
  assert.equal(getActiveSandboxCapability("bash"), undefined, "expirée au-delà du TTL");
});

test("une attestation dont la probe jette est traitée fail-closed", (t) => {
  clearSandboxCapabilitiesForTests();
  t.after(() => clearSandboxCapabilitiesForTests());
  registerSandboxCapability({
    toolName: "bash",
    backend: "gondolin-test",
    hostMounts: 0,
    network: "deny",
    isActive: () => {
      throw new Error("probe-daemon-injoignable");
    },
  });
  assert.equal(getActiveSandboxCapability("bash"), undefined);
});
