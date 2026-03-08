/**
 * Deep research schema - batch research with dynamic token allocation
 */

import { z } from 'zod';

const fileAttachmentSchema = z.object({
  path: z
    .string({ required_error: 'deep_research: File path is required' })
    .min(1, { message: 'deep_research: File path cannot be empty' })
    .describe('Absolute file path to attach (required for code-grounded research). Use full path, not relative path.'),
  start_line: z
    .number({ invalid_type_error: 'deep_research: start_line must be a number' })
    .int({ message: 'deep_research: start_line must be an integer' })
    .positive({ message: 'deep_research: start_line must be a positive integer (1-indexed)' })
    .optional()
    .describe('Optional start line (1-indexed) to scope large files.'),
  end_line: z
    .number({ invalid_type_error: 'deep_research: end_line must be a number' })
    .int({ message: 'deep_research: end_line must be an integer' })
    .positive({ message: 'deep_research: end_line must be a positive integer (1-indexed)' })
    .optional()
    .describe('Optional end line (1-indexed) to scope large files.'),
  description: z
    .string()
    .optional()
    .describe('Optional but recommended: what this file is, why relevant, and what to inspect.'),
});

const researchQuestionSchema = z.object({
  question: z
    .string({ required_error: 'deep_research: Question is required' })
    .min(10, { message: 'deep_research: Question must be at least 10 characters' })
    .describe('Structured question recommended: GOAL, WHY, KNOWN, APPLY, and 2-5 specific sub-questions. Optional: preferred sources and priority lens (performance/security/cost). You may request output style (markdown tables or nested lists up to depth 5). Keep concrete, concise, and comprehensive.'),
  file_attachments: z
    .array(fileAttachmentSchema)
    .optional()
    .describe('Attach relevant code files when answer quality depends on your codebase (bugs, perf, refactor, review, architecture). Use absolute paths and minimal focused ranges.'),
});

const deepResearchParamsShape = {
  questions: z
    .array(researchQuestionSchema, {
      required_error: 'deep_research: Questions array is required',
      invalid_type_error: 'deep_research: Questions must be an array'
    })
    .min(1, { message: 'deep_research: At least 1 question is required (recommend 2-7 for optimal depth)' })
    .max(10, { message: 'deep_research: Maximum 10 questions allowed per batch' })
    .describe('Batch deep research questions (2-10 recommended). 32K tokens are split across questions; fewer questions = deeper per-question analysis. Encourage concise yet comprehensive outputs with explicit format preference when needed.'),
};

export const deepResearchParamsSchema = z.object(deepResearchParamsShape);
export type DeepResearchParams = z.infer<typeof deepResearchParamsSchema>;
