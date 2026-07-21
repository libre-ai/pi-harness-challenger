import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";

import { createFailClosedVm, execBounded, waitForExit } from "./sandbox.mjs";

function privateIpv4() {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) return address.address;
    }
  }
  return undefined;
}

async function createHostCanaryServer() {
  const address = privateIpv4();
  if (!address) return undefined;
  let connections = 0;
  let bytes = 0;
  const server = createServer((socket) => {
    connections += 1;
    socket.on("data", (chunk) => { bytes += chunk.length; });
    socket.end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", resolve);
  });
  const info = server.address();
  if (!info || typeof info === "string") throw new Error("host-canary-listener-unavailable");
  return {
    address,
    port: info.port,
    metrics: () => ({ connections, bytes }),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

const hostFixture = mkdtempSync(join(tmpdir(), "gondolin-host-canary-"));
const hostCanary = join(hostFixture, "host-only.txt");
writeFileSync(hostCanary, "synthetic-host-canary\n", { mode: 0o600 });
const canaryServer = await createHostCanaryServer();
let vm;
let hostPid;

try {
  vm = await createFailClosedVm();

  await vm.fs.mkdir("/workspace", { recursive: true });
  await vm.fs.writeFile("/workspace/input.txt", "synthetic fixture\n", { encoding: "utf8" });
  const copied = await vm.fs.readFile("/workspace/input.txt", { encoding: "utf8" });
  const guestWrite = await execBounded(vm, "printf 'guest output\\n' > /workspace/output.txt && cat /workspace/output.txt");
  hostPid = vm.getHostPid();
  const hostCanaryProbe = await execBounded(vm, `test -e ${JSON.stringify(hostCanary)}`);

  const httpProbe = await execBounded(vm, "timeout 6 wget -qO- http://example.com >/dev/null 2>&1");
  const httpsProbe = await execBounded(vm, "timeout 6 wget -qO- https://example.com >/dev/null 2>&1");
  const ncAvailable = await execBounded(vm, "command -v nc >/dev/null 2>&1");
  if (canaryServer && ncAvailable.exitCode === 0) {
    await execBounded(
      vm,
      `printf 'synthetic-egress-canary' | timeout 6 nc -w 3 ${canaryServer.address} ${canaryServer.port} >/dev/null 2>&1 || true`,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  const canaryMetrics = canaryServer?.metrics();
  const dnsProbe = await execBounded(vm, "nslookup example.com 2>/dev/null || true");

  let timeoutTriggered = false;
  try {
    await execBounded(vm, "sleep 30", 200);
  } catch (error) {
    timeoutTriggered = error instanceof Error && error.message === "sandbox-command-timeout:200";
  }
  const vmExitedAfterTimeout = await waitForExit(hostPid);
  let postTimeoutExecRejected = false;
  try {
    await vm.exec("true");
  } catch {
    postTimeoutExecRejected = true;
  }

  const report = {
    version: 2,
    backend: "@earendil-works/gondolin@0.12.0",
    guestStarted: copied === "synthetic fixture\n" && guestWrite.exitCode === 0,
    hostPidReported: Boolean(hostPid),
    filesystem: {
      fixtureCopiedIntoGuest: copied === "synthetic fixture\n",
      guestWriteSucceeded: guestWrite.exitCode === 0 && guestWrite.stdout === "guest output\n",
      hostCanaryVisible: hostCanaryProbe.exitCode === 0,
      hostMountConfigured: false,
    },
    network: {
      policy: "deny-http-ip-hooks-empty-tcp-synthetic-dns",
      httpBlocked: httpProbe.exitCode !== 0,
      httpsBlocked: httpsProbe.exitCode !== 0,
      controlledTcpProbeSupported: Boolean(canaryServer) && ncAvailable.exitCode === 0,
      hostListenerConnections: canaryMetrics?.connections ?? null,
      hostListenerBytes: canaryMetrics?.bytes ?? null,
      controlledTcpBlocked: canaryMetrics ? canaryMetrics.connections === 0 && canaryMetrics.bytes === 0 : null,
      dnsUsesSyntheticAddress: dnsProbe.stdout.includes("192.0.2.1") || dnsProbe.stdout.includes("2001:db8::1"),
    },
    failClosed: {
      hostFallbackImplemented: false,
      timeoutPolicy: "abort-and-close-entire-vm",
      timeoutTriggered,
      hostPidExitedAfterTimeout: hostPid ? vmExitedAfterTimeout : null,
      postTimeoutExecRejected,
    },
  };
  report.allPass = report.guestStarted
    && report.filesystem.fixtureCopiedIntoGuest
    && report.filesystem.guestWriteSucceeded
    && !report.filesystem.hostCanaryVisible
    && report.network.httpBlocked
    && report.network.httpsBlocked
    && report.network.controlledTcpBlocked === true
    && report.network.dnsUsesSyntheticAddress
    && report.failClosed.timeoutTriggered
    && report.failClosed.postTimeoutExecRejected
    && (report.failClosed.hostPidExitedAfterTimeout ?? true);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  if (vm) await vm.close().catch(() => {});
  await canaryServer?.close().catch(() => {});
  const qemuExited = await waitForExit(hostPid);
  rmSync(hostFixture, { recursive: true, force: true });
  if (!qemuExited) throw new Error("gondolin-qemu-process-did-not-exit");
}
