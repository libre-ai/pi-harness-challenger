const REGISTRY_KEY = Symbol.for("pi-harness-challenger.sandbox-capabilities.v1");

function registry() {
  if (!(globalThis[REGISTRY_KEY] instanceof Map)) globalThis[REGISTRY_KEY] = new Map();
  return globalThis[REGISTRY_KEY];
}

export function registerSandboxCapability({ toolName, backend, hostMounts, network, isActive }) {
  const normalizedTool = String(toolName ?? "").replace(/^functions\./, "").toLowerCase();
  if (!normalizedTool) throw new Error("sandbox-capability-tool-required");
  if (typeof backend !== "string" || !backend) throw new Error("sandbox-capability-backend-required");
  if (hostMounts !== 0) throw new Error("sandbox-capability-host-mounts-must-be-zero");
  if (network !== "deny") throw new Error("sandbox-capability-network-must-be-deny");
  if (typeof isActive !== "function") throw new Error("sandbox-capability-active-probe-required");

  const current = registry().get(normalizedTool);
  if (current) {
    try {
      if (current.isActive() === true) throw new Error("sandbox-capability-already-active");
    } catch (error) {
      if (error instanceof Error && error.message === "sandbox-capability-already-active") throw error;
    }
  }
  const token = Symbol(`${backend}:${normalizedTool}`);
  registry().set(normalizedTool, { token, backend, hostMounts, network, isActive });
  return () => {
    const current = registry().get(normalizedTool);
    if (current?.token === token) registry().delete(normalizedTool);
  };
}

export function getActiveSandboxCapability(toolName) {
  const normalizedTool = String(toolName ?? "").replace(/^functions\./, "").toLowerCase();
  const capability = registry().get(normalizedTool);
  if (!capability) return undefined;
  try {
    if (capability.isActive() !== true) return undefined;
  } catch {
    return undefined;
  }
  return {
    backend: capability.backend,
    hostMounts: capability.hostMounts,
    network: capability.network,
  };
}

export function clearSandboxCapabilitiesForTests() {
  registry().clear();
}
