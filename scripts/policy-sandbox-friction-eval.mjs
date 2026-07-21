import {
  clearSandboxCapabilitiesForTests,
  registerSandboxCapability,
} from "../extensions/policy-gate/capabilities.mjs";
import { classifyToolCall, decidePreflight } from "../extensions/policy-gate/policy.mjs";
import { LOCAL_REVERSIBLE_COMMAND_FIXTURES as fixtures } from "./lib/policy-fixtures.mjs";

clearSandboxCapabilitiesForTests();
let active = true;
const unregister = registerSandboxCapability({
  toolName: "bash",
  backend: "gondolin-evaluated",
  hostMounts: 0,
  network: "deny",
  isActive: () => active,
});

try {
  const classifications = fixtures.map(({ id, command }) => {
    const classification = classifyToolCall({ toolName: "bash", input: { command } });
    return {
      id,
      risk: classification.risk,
      tui: decidePreflight({ mode: "confirm", classification, hasUI: true }).action,
      headless: decidePreflight({ mode: "confirm", classification, hasUI: false }).action,
      backend: classification.sandbox?.backend ?? null,
    };
  });
  const confirmationCount = classifications.filter((item) => item.tui === "confirm").length;
  const headlessBlockCount = classifications.filter((item) => item.headless === "block").length;
  const confirmationRate = confirmationCount / classifications.length;

  process.stdout.write(`${JSON.stringify({
    version: 1,
    fixturePolicy: "same-sixteen-local-operations-with-active-gondolin-attestation",
    operationCount: classifications.length,
    riskDistribution: {
      R0: classifications.filter((item) => item.risk === "R0").length,
      R1: classifications.filter((item) => item.risk === "R1").length,
      R2: classifications.filter((item) => item.risk === "R2").length,
      R3: classifications.filter((item) => item.risk === "R3").length,
    },
    confirmMode: {
      confirmationCount,
      confirmationRate,
      headlessBlockCount,
      acceptanceThreshold: 0.1,
      passesAcceptance: confirmationRate < 0.1,
    },
    allAttested: classifications.every((item) => item.backend === "gondolin-evaluated"),
    classifications,
  }, null, 2)}\n`);
} finally {
  active = false;
  unregister();
  clearSandboxCapabilitiesForTests();
}
