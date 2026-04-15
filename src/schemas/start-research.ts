import { z } from 'zod';

export const startResearchParamsSchema = z.object({
  goal: z
    .string()
    .min(1, { message: 'start-research: goal cannot be empty' })
    .max(500, { message: 'start-research: goal too long (max 500 chars)' })
    .optional()
    .describe('Optional research goal for this conversation.'),
}).strict();

export const startResearchOutputSchema = z.object({
  content: z
    .string()
    .describe('Orientation markdown for the current research session.'),
}).strict();

export type StartResearchParams = z.infer<typeof startResearchParamsSchema>;
export type StartResearchOutput = z.infer<typeof startResearchOutputSchema>;
