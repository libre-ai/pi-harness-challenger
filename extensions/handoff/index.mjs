import { buildHandoffDraft, buildSessionTitle } from "./handoff.mjs";

/** @param {import("@earendil-works/pi-coding-agent").ExtensionAPI} pi */
export default function handoff(pi) {
  pi.registerCommand("handoff", {
    description: "Créer une session enfant avec un contexte focalisé et éditable",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("handoff nécessite une interface de validation", "error");
        return;
      }

      const goal = args.trim();
      if (!goal) {
        ctx.ui.notify("Usage : /handoff <objectif de la nouvelle session>", "warning");
        return;
      }

      await ctx.waitForIdle();
      const branch = ctx.sessionManager.getBranch();
      if (branch.length === 0) {
        ctx.ui.notify("Aucun contexte de session à transférer", "warning");
        return;
      }

      let draft;
      try {
        draft = buildHandoffDraft({
          goal,
          cwd: ctx.cwd,
          entries: branch,
          sessionName: ctx.sessionManager.getSessionName(),
        });
      } catch {
        ctx.ui.notify("Impossible de construire un handoff sanitisé", "error");
        return;
      }

      const editedPrompt = await ctx.ui.editor(
        "Vérifier le handoff avant création de la session",
        draft,
      );
      if (editedPrompt === undefined) {
        ctx.ui.notify("Handoff annulé", "info");
        return;
      }

      const finalPrompt = editedPrompt.trim();
      if (!finalPrompt) {
        ctx.ui.notify("Handoff vide : aucune session créée", "warning");
        return;
      }

      const parentSession = ctx.sessionManager.getSessionFile();
      const sessionTitle = buildSessionTitle(goal);
      const result = await ctx.newSession({
        ...(parentSession ? { parentSession } : {}),
        setup: async (sessionManager) => {
          sessionManager.appendSessionInfo(sessionTitle);
        },
        withSession: async (replacementCtx) => {
          replacementCtx.ui.setEditorText(finalPrompt);
          replacementCtx.ui.notify("Handoff prêt dans la session enfant. Soumettre après une dernière vérification.", "info");
        },
      });

      if (result.cancelled) {
        ctx.ui.notify("Création de la session enfant annulée", "info");
      }
    },
  });
}
