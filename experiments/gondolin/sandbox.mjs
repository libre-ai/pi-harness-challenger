import { randomUUID } from "node:crypto";

import { VM, createHttpHooks } from "@earendil-works/gondolin";

export const COMMAND_TIMEOUT_MS = 15_000;
export const STARTUP_TIMEOUT_MS = 180_000;

export function processAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitForExit(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (processAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !processAlive(pid);
}

export async function execBounded(vm, command, timeoutMs = COMMAND_TIMEOUT_MS, signal) {
  const controller = new AbortController();
  let timedOut = false;
  let externallyAborted = false;
  let closePromise;
  const closeVm = () => {
    controller.abort();
    closePromise ??= vm.close();
  };
  const onAbort = () => {
    externallyAborted = true;
    closeVm();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const timer = setTimeout(() => {
    timedOut = true;
    closeVm();
  }, timeoutMs);
  try {
    const result = await vm.exec(command, { signal: controller.signal });
    if (timedOut || externallyAborted) {
      await closePromise?.catch(() => {});
      throw new Error(timedOut ? `sandbox-command-timeout:${timeoutMs}` : "sandbox-command-aborted");
    }
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (timedOut || externallyAborted) {
      await closePromise?.catch(() => {});
      throw new Error(timedOut ? `sandbox-command-timeout:${timeoutMs}` : "sandbox-command-aborted");
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function createFailClosedVm(label = "pi-harness-gondolin-spike") {
  const { httpHooks } = createHttpHooks({
    allowedHosts: [],
    blockInternalRanges: true,
    isRequestAllowed: () => false,
    isIpAllowed: () => false,
  });
  return VM.create({
    httpHooks,
    dns: {
      mode: "synthetic",
      syntheticIPv4: "192.0.2.1",
      syntheticIPv6: "2001:db8::1",
      syntheticHostMapping: "single",
    },
    tcp: { hosts: {} },
    allowWebSockets: false,
    vfs: null,
    memory: "512M",
    cpus: 1,
    startTimeoutMs: STARTUP_TIMEOUT_MS,
    sessionLabel: `${label}-${randomUUID().slice(0, 8)}`,
    debugLog: null,
  });
}
