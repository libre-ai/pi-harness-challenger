import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

function commandAvailable(command) {
  const probe = spawnSync("sh", ["-lc", `command -v ${command} >/dev/null 2>&1`], {
    stdio: "ignore",
    timeout: 5_000,
  });
  return probe.status === 0;
}

const [nodeMajor, nodeMinor] = process.versions.node.split(".").map((part) => Number.parseInt(part, 10));
const nodeCompatibleWithGondolin = nodeMajor > 23 || (nodeMajor === 23 && nodeMinor >= 6);
const qemuAvailable = commandAvailable("qemu-system-aarch64") || commandAvailable("qemu-system-x86_64");
const sandboxExecAvailable = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
const bubblewrapAvailable = process.platform === "linux" && commandAvailable("bwrap");
const socatAvailable = commandAvailable("socat");

const gondolinReady = nodeCompatibleWithGondolin && qemuAvailable;
const sandboxRuntimeHostReady = sandboxExecAvailable || (bubblewrapAvailable && socatAvailable);

process.stdout.write(`${JSON.stringify({
  version: 1,
  platform: process.platform,
  nodeMajor,
  candidates: {
    gondolin: {
      license: "Apache-2.0",
      qemuAvailable,
      nodeCompatible: nodeCompatibleWithGondolin,
      hostReady: gondolinReady,
    },
    sandboxRuntime: {
      license: "Apache-2.0",
      sandboxExecAvailable,
      bubblewrapAvailable,
      socatAvailable,
      hostReady: sandboxRuntimeHostReady,
      exampleSafeByDefault: false,
    },
  },
  decision: {
    preferredBackend: "gondolin",
    readyForFailClosedSpike: gondolinReady,
    installPerformed: false,
    globalActivationAllowed: false,
  },
}, null, 2)}\n`);
