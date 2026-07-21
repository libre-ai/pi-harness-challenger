import {
  classifyCommand,
  classifyToolCall,
  decidePreflight,
} from "../extensions/policy-gate/policy.mjs";

function decisions(classification) {
  return {
    observe: decidePreflight({ mode: "observe", classification, hasUI: false }).action,
    confirmTui: decidePreflight({ mode: "confirm", classification, hasUI: true }).action,
    confirmHeadless: decidePreflight({ mode: "confirm", classification, hasUI: false }).action,
    enforceTui: decidePreflight({ mode: "enforce", classification, hasUI: true }).action,
  };
}

const sensitive = classifyToolCall({
  toolName: "read",
  input: { path: ".env.fixture" },
  cwd: process.cwd(),
});
const push = classifyCommand("git push fixture current-branch");
const destructive = classifyCommand("rm -rf build-fixture");

const cases = [
  {
    id: "sensitive-read-indirect",
    risk: sensitive.risk,
    findingCodes: sensitive.findings.map((item) => item.code),
    decisions: decisions(sensitive),
    passes: sensitive.risk === "R2"
      && decisions(sensitive).observe === "allow"
      && decisions(sensitive).confirmTui === "confirm"
      && decisions(sensitive).confirmHeadless === "block",
  },
  {
    id: "push-explicit",
    risk: push.risk,
    findingCodes: push.findings.map((item) => item.code),
    decisions: decisions(push),
    passes: push.risk === "R3"
      && decisions(push).observe === "allow"
      && decisions(push).confirmTui === "confirm"
      && decisions(push).confirmHeadless === "block",
  },
  {
    id: "destructive-shell",
    risk: destructive.risk,
    findingCodes: destructive.findings.map((item) => item.code),
    enforceDeny: destructive.enforceDeny,
    decisions: decisions(destructive),
    passes: destructive.risk === "R3"
      && destructive.enforceDeny
      && decisions(destructive).enforceTui === "block",
  },
];

process.stdout.write(`${JSON.stringify({
  version: 1,
  executionPolicy: "classification-only-no-command-execution",
  cases,
  passed: cases.filter((item) => item.passes).length,
  failed: cases.filter((item) => !item.passes).length,
  allPass: cases.every((item) => item.passes),
}, null, 2)}\n`);
