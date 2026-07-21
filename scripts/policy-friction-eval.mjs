import { classifyCommand, decidePreflight } from "../extensions/policy-gate/policy.mjs";
import { LOCAL_REVERSIBLE_COMMAND_FIXTURES as fixtures } from "./lib/policy-fixtures.mjs";

const classifications = fixtures.map(({ id, command }) => {
  const classification = classifyCommand(command);
  const tui = decidePreflight({ mode: "confirm", classification, hasUI: true });
  const headless = decidePreflight({ mode: "confirm", classification, hasUI: false });
  return { id, risk: classification.risk, tui: tui.action, headless: headless.action };
});
const count = (key, value) => classifications.filter((item) => item[key] === value).length;
const confirmationCount = count("tui", "confirm");

process.stdout.write(`${JSON.stringify({
  version: 1,
  fixturePolicy: "synthetic-known-local-operations",
  operationCount: classifications.length,
  riskDistribution: {
    R0: count("risk", "R0"),
    R1: count("risk", "R1"),
    R2: count("risk", "R2"),
    R3: count("risk", "R3"),
  },
  confirmMode: {
    confirmationCount,
    confirmationRate: confirmationCount / classifications.length,
    headlessBlockCount: count("headless", "block"),
    acceptanceThreshold: 0.1,
    passesAcceptance: confirmationCount / classifications.length < 0.1,
  },
  classifications,
}, null, 2)}\n`);
