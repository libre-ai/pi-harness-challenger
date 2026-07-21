import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createConfigStore,
  normalizePolicyMode,
  resolveConfigPath,
  strongerPolicyMode,
} from "../extensions/shared/config.mjs";

test("la configuration absente retourne les valeurs sûres de laboratoire", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = createConfigStore(join(root, "challenger", "config.json"));

  assert.deepEqual(store.load(), {
    config: { version: 1, policyMode: "observe" },
    exists: false,
  });
});

test("les mises à jour sont atomiques et privées", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "challenger", "config.json");
  const store = createConfigStore(path);

  store.update({ policyMode: "confirm" });
  store.update({ policyMode: "enforce" });

  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
    version: 1,
    policyMode: "enforce",
  });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(join(root, "challenger")).mode & 0o777, 0o700);
});

test("un fichier de configuration symlinké est refusé", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, "target.json");
  const link = join(root, "config.json");
  writeFileSync(target, JSON.stringify({ version: 1, policyMode: "observe" }));
  symlinkSync(target, link);

  assert.throws(() => createConfigStore(link).load(), /configuration-file-unsafe/);
  assert.throws(() => createConfigStore(link).update({ policyMode: "confirm" }), /configuration-file-unsafe/);
});

test("un flag ne peut que renforcer le mode durable", () => {
  assert.equal(strongerPolicyMode("observe", "confirm"), "confirm");
  assert.equal(strongerPolicyMode("enforce", "off"), "enforce");
  assert.equal(strongerPolicyMode("off", undefined), "off");
  assert.equal(normalizePolicyMode(" CONFIRM "), "confirm");
  assert.equal(normalizePolicyMode("invalid"), undefined);
});

test("le chemin peut être isolé par variable d’environnement", () => {
  assert.equal(
    resolveConfigPath({ PI_HARNESS_CHALLENGER_CONFIG: "./fixture-config.json" }),
    join(process.cwd(), "fixture-config.json"),
  );
});
