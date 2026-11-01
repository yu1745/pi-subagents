import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export const SEND_PARENT_MESSAGE = "send_parent_message";

/** The destination is bound by the manager, never chosen by the child. */
export function createParentMessageTool(send: (message: string) => void | Promise<void>) {
  return defineTool({
    name: SEND_PARENT_MESSAGE,
    label: "Message parent",
    description: "Send an interim message to your parent agent without ending your task. Proactively report findings that affect the plan, blockers needing a decision, or a necessary scope change. Include the relevant evidence and what you need; continue independent work while awaiting guidance. The completed result is returned separately in the task's required format.",
    parameters: Type.Object({ message: Type.String({ minLength: 1, description: "Concise finding or decision request, with evidence and the next action." }) }),
    execute: async (_id, params, signal) => {
      signal?.throwIfAborted();
      const message = params.message.trim();
      if (!message) throw new Error("Parent message must not be blank");
      await send(message);
      return { content: [{ type: "text" as const, text: "Message queued for your parent. Your task is still running; continue work that does not depend on the reply." }], details: {} };
    },
  });
}
