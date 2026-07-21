import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import test from "node:test";

const root = new URL("..", import.meta.url).pathname;
const skillPaths = [
  join(root, "skills", "verify-runtime", "SKILL.md"),
];

function frontmatter(path) {
  const source = readFileSync(path, "utf8");
  const match = source.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match, `${path}: frontmatter absent`);
  const values = {};
  for (const line of match[1].split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    values[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return { source, values };
}

for (const path of skillPaths) {
  test(`${basename(dirname(path))} respecte le contrat de skill manuel`, () => {
    const { source, values } = frontmatter(path);
    assert.equal(values.name, basename(dirname(path)));
    assert.ok(values.description.length > 40);
    assert.ok(values.description.length <= 1024);
    assert.equal(values.license, "Apache-2.0");
    assert.equal(values["disable-model-invocation"], "true");
    assert.equal(values["allowed-tools"], undefined);
    assert.doesNotMatch(source, /\$[0-9]/);
    assert.doesNotMatch(source, /~\/\.claude|Agent tool|Claude Code/);
    assert.match(source, /User: <cible>/);
  });
}

test("verify-runtime distingue preuve runtime et suite de tests", () => {
  const { source } = frontmatter(skillPaths[0]);
  assert.match(source, /ne relance ni tests, ni typecheck, ni lint/);
  assert.match(source, /probe adjacent/);
  assert.match(source, /PASS \| FAIL \| BLOCKED \| SKIP/);
  assert.match(source, /verify-portail/);
  assert.match(source, /~\/\.agents\/skills/);
});
