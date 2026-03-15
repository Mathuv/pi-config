/**
 * Extension loaded into panel sub-agents.
 * - Sets the terminal title to "π <panel-name>" on session start
 * - Provides a `panel_done` tool for autonomous agents to self-terminate
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
  // Set terminal title from PANEL_AGENT_NAME env var
  pi.on("session_start", async (_event, ctx) => {
    const name = process.env.PANEL_AGENT_NAME;
    if (name && ctx.hasUI) {
      ctx.ui.setTitle(`π ${name}`);
    }
  });

  pi.registerTool({
    name: "panel_done",
    label: "Panel Done",
    description:
      "Call this tool when you have completed your task. " +
      "It will close this session and return your results to the main session. " +
      "Your LAST assistant message before calling this becomes the summary returned to the caller.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      ctx.shutdown();
      return {
        content: [{ type: "text", text: "Shutting down panel session." }],
        details: {},
      };
    },
  });
}
