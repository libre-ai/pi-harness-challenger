const REGISTRY_KEY = Symbol.for("pi-harness-challenger.sandbox-capabilities.v1");

function registry() {
  if (!(globalThis[REGISTRY_KEY] instanceof Map)) globalThis[REGISTRY_KEY] = new Map();
  return globalThis[REGISTRY_KEY];
}

// Fraîcheur d'attestation : une capability enregistrée expire au bout de `ttlMs`
// même si `isActive()` continue de répondre true. Corrige le trou du challenge
// 2026-07-21 : l'attestation, auto-déclarée par le processus attesté, persistait
// indéfiniment sans re-vérification (probe morte, VM arrêtée en silence).
const DEFAULT_TTL_MS = 5 * 60 * 1000;

export function registerSandboxCapability({
  toolName,
  backend,
  hostMounts,
  network,
  isActive,
  ttlMs = DEFAULT_TTL_MS,
  now = Date.now,
}) {
  const normalizedTool = String(toolName ?? "").replace(/^functions\./, "").toLowerCase();
  if (!normalizedTool) throw new Error("sandbox-capability-tool-required");
  if (typeof backend !== "string" || !backend) throw new Error("sandbox-capability-backend-required");
  if (hostMounts !== 0) throw new Error("sandbox-capability-host-mounts-must-be-zero");
  if (network !== "deny") throw new Error("sandbox-capability-network-must-be-deny");
  if (typeof isActive !== "function") throw new Error("sandbox-capability-active-probe-required");
  if (typeof now !== "function") throw new Error("sandbox-capability-clock-required");
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("sandbox-capability-ttl-must-be-positive");

  const current = registry().get(normalizedTool);
  if (current && isCapabilityFresh(current)) {
    try {
      if (current.isActive() === true) throw new Error("sandbox-capability-already-active");
    } catch (error) {
      if (error instanceof Error && error.message === "sandbox-capability-already-active") throw error;
    }
  }
  const token = Symbol(`${backend}:${normalizedTool}`);
  registry().set(normalizedTool, { token, backend, hostMounts, network, isActive, ttlMs, now, attestedAt: now() });
  return () => {
    const current = registry().get(normalizedTool);
    if (current?.token === token) registry().delete(normalizedTool);
  };
}

function isCapabilityFresh(capability) {
  try {
    return capability.now() - capability.attestedAt <= capability.ttlMs;
  } catch {
    return false;
  }
}

export function getActiveSandboxCapability(toolName) {
  const normalizedTool = String(toolName ?? "").replace(/^functions\./, "").toLowerCase();
  const capability = registry().get(normalizedTool);
  if (!capability) return undefined;
  // Attestation périmée → éviction + fail-closed.
  if (!isCapabilityFresh(capability)) {
    registry().delete(normalizedTool);
    return undefined;
  }
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
