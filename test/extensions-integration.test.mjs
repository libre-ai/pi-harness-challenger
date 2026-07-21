import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import handoff from "../extensions/handoff/index.mjs";
import policyGate from "../extensions/policy-gate/index.mjs";

function fakePi(flagOverrides = {}) {
  const commands = new Map();
  const events = new Map();
  const flags = new Map();
  const api = {
    on(name, handler) {
      const handlers = events.get(name) ?? [];
      handlers.push(handler);
      events.set(name, handlers);
    },
    registerCommand(name, definition) {
      commands.set(name, definition);
    },
    registerFlag(name, definition) {
      flags.set(name, Object.hasOwn(flagOverrides, name) ? flagOverrides[name] : definition.default);
    },
    getFlag(name) {
      return flags.get(name);
    },
  };

  return {
    api,
    commands,
    async emit(name, event, ctx) {
      let result;
      for (const handler of events.get(name) ?? []) {
        const current = await handler(event, ctx);
        if (current !== undefined) result = current;
        if (current?.block) return current;
      }
      return result;
    },
  };
}

function fakeUi({ confirmResult = true, editorResult } = {}) {
  const statuses = [];
  const notifications = [];
  const confirmations = [];
  const editorDrafts = [];
  const editorValues = [];
  return {
    statuses,
    notifications,
    confirmations,
    editorDrafts,
    editorValues,
    setStatus(id, text) {
      statuses.push({ id, text });
    },
    notify(text, level) {
      notifications.push({ text, level });
    },
    async confirm(title, body) {
      confirmations.push({ title, body });
      return confirmResult;
    },
    async editor(title, draft) {
      editorDrafts.push({ title, draft });
      return editorResult === undefined ? draft : editorResult(draft);
    },
    setEditorText(value) {
      editorValues.push(value);
    },
  };
}

test("policy-gate observe sans bloquer puis refuse R3 sans UI en mode confirm", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-policy-runtime-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const runtime = fakePi();
  policyGate(runtime.api, { configPath: join(cwd, "config.json") });
  const ui = fakeUi();
  const context = { cwd, hasUI: false, ui };

  await runtime.emit("session_start", { reason: "startup" }, context);
  const observed = await runtime.emit("tool_call", {
    toolName: "bash",
    input: { command: "git push origin main" },
  }, context);
  assert.equal(observed, undefined);
  assert.match(ui.statuses.at(-1).text, /R3 1/);

  await runtime.commands.get("policy-gate").handler("confirm", context);
  const blocked = await runtime.emit("tool_call", {
    toolName: "bash",
    input: { command: "git push origin main" },
  }, context);
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /sans interface de confirmation/);
});

test("policy-gate confirme une fois avec commande redacted et respecte le refus", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-policy-runtime-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const secret = "runtime-fixture-secret";
  const runtime = fakePi();
  policyGate(runtime.api, { configPath: join(cwd, "config.json") });
  const ui = fakeUi({ confirmResult: false });
  const context = { cwd, hasUI: true, ui };

  await runtime.commands.get("policy-gate").handler("confirm", context);
  const result = await runtime.emit("tool_call", {
    toolName: "bash",
    input: { command: `API_TOKEN=${secret} git push origin main` },
  }, context);

  assert.equal(result.block, true);
  assert.match(result.reason, /refusée par l’utilisateur/);
  assert.equal(ui.confirmations.length, 1);
  assert.doesNotMatch(ui.confirmations[0].body, new RegExp(secret));
  assert.match(ui.confirmations[0].body, /API_TOKEN=<redacted>/);
});

test("policy-gate bloque une écriture sensible directement en mode enforce", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-policy-runtime-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const runtime = fakePi();
  policyGate(runtime.api, { configPath: join(cwd, "config.json") });
  const ui = fakeUi();
  const context = { cwd, hasUI: true, ui };

  await runtime.commands.get("policy-gate").handler("enforce", context);
  const result = await runtime.emit("tool_call", {
    toolName: "write",
    input: { path: ".env", content: "fixture" },
  }, context);

  assert.equal(result.block, true);
  assert.match(result.reason, /interdite par la politique active/);
  assert.equal(ui.confirmations.length, 0);
});

test("policy-gate conserve le mode durable après recréation de l’extension", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-policy-runtime-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const configPath = join(cwd, "config.json");

  const first = fakePi();
  policyGate(first.api, { configPath });
  await first.commands.get("policy-gate").handler("confirm", {
    cwd,
    hasUI: false,
    ui: fakeUi(),
  });

  const replacement = fakePi();
  policyGate(replacement.api, { configPath });
  const result = await replacement.emit("tool_call", {
    toolName: "mcp_custom_mutation",
    input: {},
  }, { cwd, hasUI: false, ui: fakeUi() });

  assert.equal(result.block, true);
  assert.match(result.reason, /sans interface de confirmation/);
});

test("policy-gate refuse une baisse durable non confirmée", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-policy-runtime-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const configPath = join(cwd, "config.json");
  const first = fakePi();
  policyGate(first.api, { configPath });
  await first.commands.get("policy-gate").handler("enforce", {
    cwd,
    hasUI: true,
    ui: fakeUi(),
  });

  const second = fakePi();
  policyGate(second.api, { configPath });
  const refusingUi = fakeUi({ confirmResult: false });
  await second.commands.get("policy-gate").handler("observe", {
    cwd,
    hasUI: true,
    ui: refusingUi,
  });
  await second.commands.get("policy-gate").handler("status", {
    cwd,
    hasUI: true,
    ui: refusingUi,
  });

  assert.equal(refusingUi.confirmations.length, 1);
  assert.match(refusingUi.notifications.at(-1).text, /durable enforce/);
});

test("handoff valide le brouillon avant de créer une session enfant", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-handoff-runtime-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const runtime = fakePi();
  handoff(runtime.api);
  const branch = [
    { type: "message", message: { role: "user", content: "Objectif initial" } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "[DELTA]\nFait    étape vérifiée" }] } },
  ];
  const sourceSnapshot = JSON.stringify(branch);
  const ui = fakeUi({ editorResult: (draft) => `${draft}\n\nValidation humaine` });
  const replacementUi = fakeUi();
  let options;
  let sessionTitle;
  const context = {
    cwd,
    hasUI: true,
    ui,
    waitForIdle: async () => {},
    sessionManager: {
      getBranch: () => branch,
      getSessionName: () => "Session source",
      getSessionFile: () => "/tmp/source-session.jsonl",
    },
    newSession: async (value) => {
      options = value;
      await value.setup({ appendSessionInfo: (title) => { sessionTitle = title; } });
      await value.withSession({ ui: replacementUi });
      return { cancelled: false };
    },
  };

  await runtime.commands.get("handoff").handler("Continuer A", context);

  assert.equal(options.parentSession, "/tmp/source-session.jsonl");
  assert.equal(sessionTitle, "Handoff — Continuer A");
  assert.equal(ui.editorDrafts.length, 1);
  assert.match(ui.editorDrafts[0].draft, /Continuer A/);
  assert.match(replacementUi.editorValues[0], /Validation humaine/);
  assert.equal(JSON.stringify(branch), sourceSnapshot);
});

test("handoff sans UI ne crée aucune session", async () => {
  const runtime = fakePi();
  handoff(runtime.api);
  let created = false;
  const ui = fakeUi();

  await runtime.commands.get("handoff").handler("Continuer", {
    hasUI: false,
    ui,
    newSession: async () => { created = true; },
  });

  assert.equal(created, false);
  assert.match(ui.notifications[0].text, /interface de validation/);
});
