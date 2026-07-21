import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { PiRpcClient } from "./lib/pi-rpc.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const expected = new Map([
  ["policy-gate", "extension"],
  ["handoff", "extension"],
  ["skill:verify-runtime", "skill"],
]);
const extensionErrors = [];

const client = new PiRpcClient({
  cwd: root,
  environment: { PI_OFFLINE: "1" },
  args: [
    "--mode", "rpc",
    "--no-session",
    "--offline",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "-e", "./extensions/policy-gate/index.mjs",
    "-e", "./extensions/handoff/index.mjs",
    "--skill", "./skills",
  ],
});
client.onEvent((event) => {
  if (event.type === "extension_error") extensionErrors.push(event);
});

try {
  const response = await client.request({ type: "get_commands" });
  if (extensionErrors.length > 0) throw new Error(`Extension errors: ${JSON.stringify(extensionErrors)}`);

  const commands = response.data?.commands ?? [];
  for (const [name, source] of expected) {
    const command = commands.find((candidate) => candidate.name === name);
    if (!command) throw new Error(`Missing RPC command: ${name}`);
    if (command.source !== source) throw new Error(`Unexpected source for ${name}: ${command.source}`);
  }

  console.log(`rpc commands: ok (${expected.size}/${expected.size})`);
} finally {
  await client.close();
}

if (client.stderr.trim()) throw new Error(`Unexpected Pi RPC stderr: ${client.stderr.trim()}`);
