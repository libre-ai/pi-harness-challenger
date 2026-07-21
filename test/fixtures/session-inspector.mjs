/** @param {import("@earendil-works/pi-coding-agent").ExtensionAPI} pi */
export default function sessionInspector(pi) {
  pi.registerCommand("inspect-session-header", {
    description: "Test-only: inspect the in-memory session header",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`RPC_SESSION_HEADER:${JSON.stringify(ctx.sessionManager.getHeader())}`, "info");
    },
  });
}
