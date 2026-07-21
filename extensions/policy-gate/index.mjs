import {
  DEFAULT_MODE,
  MODES,
  classifyToolCall,
  createCounters,
  decidePreflight,
  formatConfirmation,
  formatStatus,
  normalizeMode,
  recordDecision,
} from "./policy.mjs";
import {
  POLICY_MODE_RANK,
  createConfigStore,
  strongerPolicyMode,
} from "../shared/config.mjs";

/**
 * @param {import("@earendil-works/pi-coding-agent").ExtensionAPI} pi
 * @param {{ configPath?: string }} [options]
 */
export default function policyGate(pi, options = {}) {
  pi.registerFlag("policy-gate-mode", {
    description: "Renforcer le mode durable de policy-gate pour ce processus",
    type: "string",
  });

  const store = createConfigStore(options.configPath);
  const counters = createCounters();
  let persistentMode = DEFAULT_MODE;
  let configurationWarning;

  try {
    persistentMode = store.load().config.policyMode;
  } catch {
    persistentMode = "confirm";
    configurationWarning = "Configuration policy-gate invalide : mode confirm appliqué par sécurité";
  }

  const rawFlagMode = pi.getFlag("policy-gate-mode");
  const flagMode = rawFlagMode === undefined ? undefined : normalizeMode(rawFlagMode);
  if (rawFlagMode !== undefined && !flagMode) {
    configurationWarning = "Flag policy-gate-mode invalide : valeur durable conservée";
  }

  let mode = strongerPolicyMode(persistentMode, flagMode);

  const detailedStatus = () => {
    const flag = flagMode ? ` · flag ${flagMode}` : "";
    return `${formatStatus(mode, counters)} · durable ${persistentMode}${flag}`;
  };

  const refreshStatus = (ctx) => {
    ctx.ui.setStatus("policy-gate", mode === "off" ? undefined : detailedStatus());
  };

  pi.on("session_start", async (_event, ctx) => {
    refreshStatus(ctx);
    if (configurationWarning) ctx.ui.notify(configurationWarning, "warning");
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setStatus("policy-gate", undefined);
  });

  pi.registerCommand("policy-gate", {
    description: "Afficher ou changer durablement le mode de la garde de risques",
    handler: async (args, ctx) => {
      const requested = args.trim().toLowerCase().replace(/^set\s+/, "");
      if (requested === "" || requested === "status") {
        ctx.ui.notify(detailedStatus(), "info");
        return;
      }

      const nextMode = normalizeMode(requested);
      if (!nextMode) {
        ctx.ui.notify(`Mode inconnu. Valeurs : ${MODES.join(", ")}`, "warning");
        return;
      }

      const lowersProtection = POLICY_MODE_RANK[nextMode] < POLICY_MODE_RANK[persistentMode];
      if (lowersProtection) {
        if (!ctx.hasUI) {
          ctx.ui.notify("Réduction de protection refusée sans interface de confirmation", "error");
          return;
        }
        const confirmed = await ctx.ui.confirm(
          "Réduire la protection policy-gate ?",
          `Mode durable : ${persistentMode} → ${nextMode}. Cette baisse s’appliquera aux prochaines sessions.`,
        );
        if (!confirmed) {
          ctx.ui.notify("Mode durable inchangé", "info");
          return;
        }
      }

      try {
        persistentMode = store.update({ policyMode: nextMode }).policyMode;
      } catch {
        ctx.ui.notify("Impossible d’écrire la configuration policy-gate de manière sûre", "error");
        return;
      }

      mode = strongerPolicyMode(persistentMode, flagMode);
      refreshStatus(ctx);
      const flagNotice = flagMode && mode !== persistentMode ? ` ; flag ${flagMode} maintenu` : "";
      ctx.ui.notify(`policy-gate : mode effectif ${mode}${flagNotice}`, mode === "off" ? "warning" : "info");
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    if (mode === "off") return undefined;

    let classification;
    try {
      classification = classifyToolCall({
        toolName: event.toolName,
        input: event.input,
        cwd: ctx.cwd,
      });
    } catch {
      counters.errors += 1;
      refreshStatus(ctx);
      if (mode === "observe") return undefined;
      return { block: true, reason: "policy-gate : classification impossible en mode restrictif" };
    }

    if (mode === "observe") {
      recordDecision(counters, classification, classification.level >= 2 ? "observed" : "allowed");
      refreshStatus(ctx);
      return undefined;
    }

    const preflight = decidePreflight({ mode, classification, hasUI: ctx.hasUI });
    if (preflight.action === "allow") {
      recordDecision(counters, classification, "allowed");
      refreshStatus(ctx);
      return undefined;
    }

    if (preflight.action === "block") {
      recordDecision(counters, classification, "blocked");
      refreshStatus(ctx);
      const reasons = {
        "enforce-deny": `opération ${classification.risk} interdite par la politique active`,
        "confirmation-unavailable": `opération ${classification.risk} bloquée sans interface de confirmation`,
        "invalid-mode": "mode de sécurité invalide",
      };
      return { block: true, reason: `policy-gate : ${reasons[preflight.reason] ?? "opération bloquée"}` };
    }

    const allowed = await ctx.ui.confirm(
      `policy-gate · ${classification.risk}`,
      formatConfirmation(classification, event.input),
    );

    recordDecision(counters, classification, allowed ? "confirmed" : "blocked");
    refreshStatus(ctx);

    if (!allowed) {
      return { block: true, reason: "policy-gate : opération refusée par l’utilisateur" };
    }

    return undefined;
  });
}
