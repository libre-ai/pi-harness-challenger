import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const corpusPath = join(root, "evals", "cases", "phase-a.json");
const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
const evaluated = corpus.cases.filter((item) => item.evaluationStatus !== "not-run");
const groups = new Map();

for (const item of corpus.cases) {
  if (!groups.has(item.component)) groups.set(item.component, []);
  groups.get(item.component).push(item);
}

function componentVerdict(items) {
  const evaluatedItems = items.filter((item) => item.evaluationStatus !== "not-run");
  const hasPass = evaluatedItems.some((item) => item.evaluationStatus === "challenger-pass");
  const hasFailure = evaluatedItems.some((item) => item.evaluationStatus === "failed");
  const allRejected = evaluatedItems.length > 0
    && evaluatedItems.every((item) => item.evaluationStatus === "no-incremental-value")
    && evaluatedItems.every((item) => item.implementationStatus === "rejected");

  if (allRejected) return "rejected";
  if (hasPass && hasFailure) return "retained-blocked";
  if (hasPass) return "retained-lab";
  if (hasFailure) return "blocked";
  return "pending";
}

const components = [...groups.entries()]
  .map(([component, items]) => ({
    component,
    verdict: componentVerdict(items),
    evaluatedCases: items
      .filter((item) => item.evaluationStatus !== "not-run")
      .map((item) => item.id)
      .sort(),
    pendingCases: items.filter((item) => item.evaluationStatus === "not-run").length,
  }))
  .sort((left, right) => left.component.localeCompare(right.component));

const evidence = evaluated.map((item) => {
  const relativePath = item.evidence;
  const absolutePath = typeof relativePath === "string" ? join(root, relativePath) : undefined;
  let valid = false;
  let reportExplicitlyInvalid = false;
  let supersededBy;
  if (absolutePath && existsSync(absolutePath)) {
    const report = JSON.parse(readFileSync(absolutePath, "utf8"));
    valid = true;
    reportExplicitlyInvalid = report.valid === false || report.decision?.verdict === "invalid-run";
    supersededBy = report.decision?.supersededBy;
  }
  return { id: item.id, evidencePresent: valid, reportExplicitlyInvalid, supersededBy };
});

const statusCounts = Object.fromEntries(
  ["not-run", "baseline-pass", "challenger-pass", "no-incremental-value", "failed", "invalidated", "superseded"]
    .map((status) => [status, corpus.cases.filter((item) => item.evaluationStatus === status).length]),
);
const blockingComponents = components
  .filter((item) => item.verdict === "blocked" || item.verdict === "retained-blocked")
  .map((item) => item.component);
const evidenceComplete = evidence.every((item) => item.evidencePresent);
const invalidRunsAcknowledged = evidence
  .filter((item) => item.reportExplicitlyInvalid)
  .every((item) => corpus.cases.find((candidate) => candidate.id === item.id)?.evaluationStatus === "invalidated");
const supersededRunsLinked = evidence
  .filter((item) => corpus.cases.find((candidate) => candidate.id === item.id)?.evaluationStatus === "superseded")
  .every((item) => typeof item.supersededBy === "string" && existsSync(join(root, item.supersededBy)));

const casesById = new Map(corpus.cases.map((item) => [item.id, item]));
const allPassed = (ids) => ids.every((id) => casesById.get(id)?.evaluationStatus === "challenger-pass");
const gondolinTechnicalCases = [
  "policy-sandbox-friction",
  "sandbox-gondolin-boundaries",
  "sandbox-gondolin-agent-routing",
  "sandbox-gondolin-structured-routing",
  "sandbox-gondolin-export-preview",
  "sandbox-gondolin-snapshot-apply",
  "sandbox-gondolin-rpc-launcher",
  "sandbox-gondolin-deployment",
  "sandbox-gondolin-representative-project",
  "handoff-code-gondolin",
  "handoff-representative-gondolin",
];
const gondolinTechnicalReady = allPassed(gondolinTechnicalCases);
const licenseApproved = casesById.get("sandbox-license-policy")?.evaluationStatus === "challenger-pass";
const deploymentCheck = spawnSync(process.execPath, [join(root, "experiments", "gondolin", "deploy-local.mjs"), "status"], {
  cwd: root,
  encoding: "utf8",
  timeout: 30_000,
});
let liveDeployment;
try {
  liveDeployment = deploymentCheck.status === 0 ? JSON.parse(deploymentCheck.stdout) : undefined;
} catch {
  liveDeployment = undefined;
}
const deploymentEntryPointEnforced = casesById.get("sandbox-gondolin-deployment")?.evaluationStatus === "challenger-pass"
  && liveDeployment?.deployed === true
  && liveDeployment?.directRpcRefused === true
  && liveDeployment?.directRpcEntryRefused === true;
const gondolinPromotionBlockers = [
  ...(!licenseApproved ? ["sandbox-license-policy"] : []),
  ...(!deploymentEntryPointEnforced ? ["mandatory-launcher-enforcement-not-deployed"] : []),
];

process.stdout.write(`${JSON.stringify({
  version: 3,
  corpusVersion: corpus.version,
  totalCases: corpus.cases.length,
  evaluatedCases: evaluated.length,
  statusCounts,
  components,
  evidence: {
    complete: evidenceComplete,
    invalidRunsAcknowledged,
    supersededRunsLinked,
    checkedCount: evidence.length,
  },
  profiles: {
    unsandboxedPolicy: {
      ready: casesById.get("policy-local-friction")?.evaluationStatus === "challenger-pass",
      evidenceCase: "policy-local-friction",
    },
    gondolinLab: {
      technicalReady: gondolinTechnicalReady,
      liveDeployment: deploymentEntryPointEnforced,
      requiredCases: gondolinTechnicalCases,
      promotionAllowed: gondolinTechnicalReady && gondolinPromotionBlockers.length === 0,
      promotionBlockers: gondolinPromotionBlockers,
    },
    handoffRepresentative: {
      ready: casesById.get("handoff-representative-gondolin")?.evaluationStatus === "challenger-pass",
      evidenceCase: "handoff-representative-gondolin",
    },
  },
  gates: {
    blockingComponents,
    globalPromotionAllowed: evidenceComplete
      && invalidRunsAcknowledged
      && supersededRunsLinked
      && blockingComponents.length === 0
      && statusCounts["not-run"] === 0,
  },
}, null, 2)}\n`);
