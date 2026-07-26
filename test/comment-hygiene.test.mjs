import assert from "node:assert/strict";
import test from "node:test";

import {
  analyze,
  extractComments,
  isUnreferencedTaskMarker,
  looksLikeCommentedOutCode,
} from "../scripts/comment-hygiene.mjs";

const textsOf = (source) => extractComments(source).map((comment) => comment.text);

test("le contenu d’un littéral de gabarit n’est pas lu comme un commentaire", () => {
  // Reproduit experiments/gondolin/extension.mjs : un shim shell dans un
  // template literal, dont la branche `*)` ressemble à une ligne de JSDoc.
  const source = ["const SHIM = `", "case \"$1\" in", "  *) printf 'nope' >&2; exit 2 ;;", "esac", "`;"].join("\n");
  assert.deepEqual(textsOf(source), []);
});

test("un marqueur TODO dans une chaîne de données n’est pas un commentaire", () => {
  // Reproduit scripts/lib/policy-fixtures.mjs : `rg -n TODO src` est une fixture.
  const source = 'const fixtures = [{ id: "text-search", command: "rg -n TODO src" }];';
  assert.deepEqual(textsOf(source), []);
  assert.deepEqual(analyze([{ path: "fixture.mjs", source }]), []);
});

test("un // à l’intérieur d’une chaîne ou d’une regex n’ouvre pas de commentaire", () => {
  assert.deepEqual(textsOf('const url = "https://example.test/a//b";'), []);
  assert.deepEqual(textsOf("const pattern = /[/]\\/x/i;"), []);
});

test("les commentaires de ligne et de bloc sont extraits avec leur numéro de ligne", () => {
  const comments = extractComments(["const a = 1; // trailing", "/**", " * @param {string} x", " */"].join("\n"));
  assert.deepEqual(comments.map((comment) => [comment.line, comment.text]), [
    [1, "trailing"],
    [3, "@param {string} x"],
  ]);
  assert.equal(comments[1].jsdoc, true);
});

test("le code commenté est détecté, la prose qui contient un appel ne l’est pas", () => {
  assert.equal(looksLikeCommentedOutCode("const timeout = 5000;"), true);
  assert.equal(looksLikeCommentedOutCode("registry().delete(name);"), true);
  assert.equal(looksLikeCommentedOutCode("return undefined;"), true);

  // Le cas exact de test/policy-gate-hardening.test.mjs : une phrase française
  // qui contient un appel de fonction. L’ancrage en fin de ligne la protège.
  assert.equal(
    looksLikeCommentedOutCode("python3 -c 'print(1)' est inoffensif : R3 pour visibilité, mais enforceDeny=false"),
    false,
  );
  assert.equal(looksLikeCommentedOutCode("Attestation périmée → éviction + fail-closed."), false);
  assert.equal(looksLikeCommentedOutCode("voir https://example.test/issue(1);"), false);
  assert.equal(looksLikeCommentedOutCode("@param {import(\"pi\").ExtensionAPI} pi"), false);
});

test("un marqueur de tâche exige une référence, et seul un marqueur en tête compte", () => {
  assert.equal(isUnreferencedTaskMarker("TODO: réparer ça"), true);
  assert.equal(isUnreferencedTaskMarker("FIXME plus tard"), true);

  assert.equal(isUnreferencedTaskMarker("TODO(policy-gate): borner le TTL"), false);
  assert.equal(isUnreferencedTaskMarker("TODO #42 borner le TTL"), false);
  assert.equal(isUnreferencedTaskMarker("TODO 2026-07-21 borner le TTL"), false);

  // Prose qui parle du marqueur sans en être un.
  assert.equal(isUnreferencedTaskMarker("un marqueur TODO sans référence est un aveu"), false);
});

test("les annotations JSDoc répétées ne comptent pas comme des doublons", () => {
  // `@param {…} pi` existe à l’identique dans quatre fichiers : c’est le typage
  // par fichier d’un dépôt sans TypeScript, pas une redite à supprimer.
  const jsdoc = '/** @param {import("@earendil-works/pi-coding-agent").ExtensionAPI} pi */\nexport function activate(pi) {}';
  const files = ["a.mjs", "b.mjs", "c.mjs", "d.mjs"].map((path) => ({ path, source: jsdoc }));
  assert.deepEqual(analyze(files), []);
});

test("un commentaire de prose identique répété est signalé", () => {
  const line = "// cette explication longue est copiée telle quelle dans plusieurs fichiers\nconst x = 1;";
  const files = ["a.mjs", "b.mjs", "c.mjs"].map((path) => ({ path, source: line }));
  const findings = analyze(files);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "commentaire-duplique");
  assert.match(findings[0].text, /3 occurrences/);
});

test("un TODO orphelin fait rougir l’analyse", () => {
  const findings = analyze([{ path: "x.mjs", source: "// TODO: revenir dessus\nconst x = 1;" }]);
  assert.deepEqual(findings.map((finding) => finding.rule), ["todo-sans-reference"]);
});
