import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Ce contrôle ne couvre QUE le mécanisable : code commenté, marqueur TODO sans
// référence, commentaire dupliqué. Le reste (un commentaire qui ment, un
// commentaire qui paraphrase) relève du jugement et n'est pas mesuré ici —
// aucun ratio commentaires/code n'est produit : une telle métrique récompense
// l'écriture de commentaires inutiles.

const SKIP_DIRECTORIES = new Set(["node_modules", ".git", "coverage"]);

function listSourceFiles(directory, accumulator = []) {
  for (const entry of readdirSync(directory)) {
    if (SKIP_DIRECTORIES.has(entry)) continue;
    const absolutePath = join(directory, entry);
    if (statSync(absolutePath).isDirectory()) listSourceFiles(absolutePath, accumulator);
    else if (entry.endsWith(".mjs")) accumulator.push(absolutePath);
  }
  return accumulator;
}

// Un scanner par caractères, et non une regex ligne à ligne. Deux pièges réels
// de ce dépôt imposent de connaître les chaînes et les littéraux de gabarit :
//
//   experiments/gondolin/extension.mjs — un shim shell dans un template literal
//     contient `*) printf ... ;;`, que `^\s*\*` prend pour du JSDoc ;
//   scripts/lib/policy-fixtures.mjs    — la fixture `rg -n TODO src` est une
//     donnée de test, pas un marqueur TODO à traiter.
//
// Les littéraux de regex sont suivis eux aussi : policy.mjs en est constellé et
// une classe de caractères peut contenir `/`.
const REGEX_ALLOWED_AFTER = new Set("(,=:[!&|?{};+-*%~^<>".split(""));

export function extractComments(source) {
  const comments = [];
  const total = source.length;
  const stack = [];
  let index = 0;
  let line = 1;
  let previousSignificant = "";

  const topFrame = () => stack[stack.length - 1];
  const insideTemplate = () => topFrame()?.type === "template";

  while (index < total) {
    const character = source[index];
    const lookahead = source[index + 1];

    if (insideTemplate()) {
      if (character === "\\") {
        if (source[index + 1] === "\n") line += 1;
        index += 2;
        continue;
      }
      if (character === "\n") {
        line += 1;
        index += 1;
        continue;
      }
      if (character === "`") {
        stack.pop();
        previousSignificant = "`";
        index += 1;
        continue;
      }
      if (character === "$" && lookahead === "{") {
        stack.push({ type: "interpolation", braces: 0 });
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }

    if (character === "\n") {
      line += 1;
      index += 1;
      continue;
    }
    if (character === " " || character === "\t" || character === "\r") {
      index += 1;
      continue;
    }

    if (character === "/" && lookahead === "/") {
      const startLine = line;
      index += 2;
      let text = "";
      while (index < total && source[index] !== "\n") {
        text += source[index];
        index += 1;
      }
      comments.push({ line: startLine, text: text.trim(), jsdoc: false });
      continue;
    }

    if (character === "/" && lookahead === "*") {
      const startLine = line;
      const jsdoc = source[index + 2] === "*";
      index += 2;
      let text = "";
      while (index < total && !(source[index] === "*" && source[index + 1] === "/")) {
        if (source[index] === "\n") line += 1;
        text += source[index];
        index += 1;
      }
      index += 2;
      for (const [offset, rawLine] of text.split("\n").entries()) {
        const cleaned = rawLine.replace(/^\s*\*?\s?/, "").trim();
        if (cleaned) comments.push({ line: startLine + offset, text: cleaned, jsdoc });
      }
      continue;
    }

    if (character === "'" || character === '"') {
      index += 1;
      while (index < total) {
        if (source[index] === "\\") {
          index += 2;
          continue;
        }
        if (source[index] === "\n") {
          line += 1;
          index += 1;
          break;
        }
        if (source[index] === character) {
          index += 1;
          break;
        }
        index += 1;
      }
      previousSignificant = character;
      continue;
    }

    if (character === "`") {
      stack.push({ type: "template" });
      index += 1;
      continue;
    }

    if (character === "/" && (previousSignificant === "" || REGEX_ALLOWED_AFTER.has(previousSignificant))) {
      index += 1;
      let insideClass = false;
      while (index < total) {
        const current = source[index];
        if (current === "\\") {
          index += 2;
          continue;
        }
        if (current === "\n") {
          line += 1;
          index += 1;
          break;
        }
        if (current === "[") insideClass = true;
        else if (current === "]") insideClass = false;
        else if (current === "/" && !insideClass) {
          index += 1;
          break;
        }
        index += 1;
      }
      while (index < total && /[a-z]/i.test(source[index])) index += 1;
      previousSignificant = "/";
      continue;
    }

    if (character === "{") {
      const frame = topFrame();
      if (frame?.type === "interpolation") frame.braces += 1;
    } else if (character === "}") {
      const frame = topFrame();
      if (frame?.type === "interpolation") {
        if (frame.braces === 0) {
          stack.pop();
          index += 1;
          continue;
        }
        frame.braces -= 1;
      }
    }

    previousSignificant = character;
    index += 1;
  }

  return comments;
}

// Marqueurs de prose employés dans ce dépôt. Leur présence disqualifie la
// détection de « code commenté » : `python3 -c 'print(1)' est inoffensif : …`
// est une phrase, pas du code mort.
const PROSE_MARKERS = ["—", "→", "«", "»", "…"];
const CODE_KEYWORD = /^(?:const|let|var|function|class|import|export|return|if|for|while|switch|try|catch|throw|await|async|new|delete)\b/;
// Ancrage en fin de ligne : sans le `$`, toute phrase contenant un appel entre
// parenthèses serait prise pour un appel de fonction commenté.
const CODE_CALL = /^[\w$.[\]]+\s*\([^()]*\)\s*;?$/;
// Appel chaîné (`registry().delete(name);`) : le point-virgule final porte la
// décision, une phrase de prose n'en a pas.
const CODE_STATEMENT_CALL = /^[\w$.[\]]+[^;]*\([^;]*\)\s*;$/;
const CODE_ASSIGNMENT = /^[\w$.[\]]+\s*=[^=>].*;$/;
const CODE_ARROW = /=>\s*[{(]?\s*$/;

export function looksLikeCommentedOutCode(text) {
  if (!text) return false;
  if (text.startsWith("@")) return false;
  if (/https?:\/\//.test(text)) return false;
  if (PROSE_MARKERS.some((marker) => text.includes(marker))) return false;
  if (text.split(/\s+/).length > 14) return false;
  return (
    CODE_KEYWORD.test(text) ||
    CODE_CALL.test(text) ||
    CODE_STATEMENT_CALL.test(text) ||
    CODE_ASSIGNMENT.test(text) ||
    CODE_ARROW.test(text)
  );
}

// Marqueur ancré en tête de commentaire. Un `TODO` en milieu de phrase parle du
// marqueur, il n'en est pas un — sans cet ancrage, ce fichier se signale
// lui-même en décrivant sa propre règle.
const TASK_MARKER = /^[\s*\-—–/]*\b(?:TODO|FIXME|HACK|XXX)\b/;
// Une référence = un propriétaire `TODO(contexte):`, un ticket `#12`, une date
// ISO, ou une URL. Sans elle, le marqueur n'est pas un plan.
const TASK_REFERENCE = /\b(?:TODO|FIXME|HACK|XXX)\s*\([^)]+\)|#\d+|\d{4}-\d{2}-\d{2}|https?:\/\//;

export function isUnreferencedTaskMarker(text) {
  return TASK_MARKER.test(text) && !TASK_REFERENCE.test(text);
}

const DUPLICATE_MINIMUM_LENGTH = 40;
const DUPLICATE_MINIMUM_OCCURRENCES = 3;

export function analyze(files) {
  const findings = [];
  const duplicates = new Map();

  for (const { path, source } of files) {
    for (const comment of extractComments(source)) {
      if (looksLikeCommentedOutCode(comment.text)) {
        findings.push({ path, line: comment.line, rule: "code-commente", text: comment.text });
      }
      if (isUnreferencedTaskMarker(comment.text)) {
        findings.push({ path, line: comment.line, rule: "todo-sans-reference", text: comment.text });
      }
      // Les lignes JSDoc sont exclues du dédoublonnage : `@param {…} pi` est une
      // annotation de type par fichier, pas une redite. La supprimer casserait
      // le typage dans un dépôt sans TypeScript.
      if (!comment.jsdoc && !comment.text.startsWith("@") && comment.text.length >= DUPLICATE_MINIMUM_LENGTH) {
        const existing = duplicates.get(comment.text) ?? [];
        existing.push({ path, line: comment.line });
        duplicates.set(comment.text, existing);
      }
    }
  }

  for (const [text, occurrences] of duplicates) {
    if (occurrences.length < DUPLICATE_MINIMUM_OCCURRENCES) continue;
    findings.push({
      path: occurrences[0].path,
      line: occurrences[0].line,
      rule: "commentaire-duplique",
      text: `${text} (${occurrences.length} occurrences)`,
    });
  }

  return findings;
}

function main() {
  // Racine surchargeable : rend le garde-fou « zéro fichier » démontrable sur un
  // répertoire vide, au lieu d'être une branche que rien n'exécute jamais.
  const scanRoot = process.argv[2] ? resolve(process.argv[2]) : root;
  const files = listSourceFiles(scanRoot).map((absolutePath) => ({
    path: relative(scanRoot, absolutePath),
    source: readFileSync(absolutePath, "utf8"),
  }));

  // Un garde-fou muet est un garde-fou absent : si le parcours ne trouve rien,
  // le contrôle échoue au lieu de rendre un vert vide.
  console.log(`comment-hygiene: ${files.length} fichiers .mjs scannés`);
  if (files.length === 0) {
    console.error("comment-hygiene: aucun fichier scanné — parcours cassé, refus de rendre un vert vide.");
    process.exit(1);
  }

  const findings = analyze(files);
  for (const finding of findings) {
    console.error(`${finding.path}:${finding.line}: [${finding.rule}] ${finding.text}`);
  }

  if (findings.length > 0) {
    console.error(`comment-hygiene: ${findings.length} problème(s) mécanisable(s).`);
    process.exit(1);
  }
  console.log("comment-hygiene: aucun code commenté, aucun TODO orphelin, aucun doublon.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
