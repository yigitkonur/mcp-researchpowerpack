import { z } from 'zod';

export const startResearchParamsSchema = z.object({
  goal: z
    .string()
    .min(1, { message: 'start-research: goal cannot be empty' })
    .optional()
    .describe(
      'Research goal for this session. When provided AND the LLM planner (LLM_API_KEY) is available, the server returns a goal-tailored brief: classified goal type (spec | bug | migration | sentiment | pricing | security | synthesis | product_launch), a `primary_branch` recommendation (reddit for sentiment/migration; web for spec/bug/pricing; both when opinion-heavy AND needs official sources), the exact `first_call_sequence` of web-search + scrape-links calls to fire, 25–50 keyword seeds for the first `web-search` call, iteration hints, gaps to watch, and stop criteria. No goal → the generic 3-tool playbook (no tailored brief). Write the goal as you would to a human researcher — one or two sentences, specific about what "done" looks like.',
    ),
  include_playbook: z
    .boolean()
    .default(false)
    .describe(
      'Include the full 3-tool research playbook (toolbelt overview, the loop, output discipline). Default false — when the LLM planner is offline the server emits a compact stub that already names the 3 tools and the loop. Pass true only if the agent needs the verbose tactic reference, or to override the degraded-mode shrink.',
    ),
}).strict();

export const startResearchOutputSchema = z.object({
  content: z
    .string()
    .describe('Orientation markdown for the current research session.'),
}).strict();

export type StartResearchParams = z.infer<typeof startResearchParamsSchema>;
export type StartResearchOutput = z.infer<typeof startResearchOutputSchema>;
