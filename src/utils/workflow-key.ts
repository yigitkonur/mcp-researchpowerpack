export interface WorkflowCaller {
  subject?: string;
  conversationId?: string;
}

export interface WorkflowKeyContext {
  session: { sessionId: string };
  client: {
    user(): WorkflowCaller | undefined;
  };
}

export function buildWorkflowKey(ctx: WorkflowKeyContext): string {
  const caller = ctx.client.user();

  if (caller?.subject && caller.conversationId) {
    return `chatgpt:${caller.subject}:${caller.conversationId}`;
  }

  if (caller?.conversationId) {
    return `conversation:${caller.conversationId}`;
  }

  return `session:${ctx.session.sessionId}`;
}
