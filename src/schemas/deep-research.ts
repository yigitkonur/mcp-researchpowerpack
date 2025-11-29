/**
 * Deep research schema - batch research with dynamic token allocation
 */

import { z } from 'zod';

const researchQuestionSchema = z.object({
  question: z
    .string()
    .min(10, 'Research question must be at least 10 characters')
    .describe('A specific research question with context, scope, and what you need answered.'),
  file_attachments: z
    .array(
      z.object({
        path: z.string().describe('File path (absolute or relative)'),
        start_line: z.number().int().positive().optional().describe('Start line (1-indexed)'),
        end_line: z.number().int().positive().optional().describe('End line (1-indexed)'),
        description: z.string().optional().describe('What to focus on'),
      })
    )
    .optional()
    .describe('Optional file attachments for this specific question'),
});

export const deepResearchParamsShape = {
  questions: z
    .array(researchQuestionSchema)
    .min(1, 'At least one research question required, but you should keep it around 6-7 at each round')
    .max(10, 'Maximum 10 research questions per batch')
    .describe(
      `**BATCH RESEARCH (1-10 questions) with dynamic token allocation.**

**TOKEN BUDGET:** 32,000 tokens distributed across all questions:
- 1 question: 32,000 tokens (maximum depth)
- 2-3 questions: ~10-16K tokens/question (deep dive, recommended for related topics)
- 5-7 questions: ~4-6K tokens/question (balanced breadth, ideal for domain exploration)
- 8-10 questions: ~3-4K tokens/question (quick multi-topic scan)

**EACH QUESTION SHOULD INCLUDE:**
1. **Topic & Why:** What you're researching and what decision it informs
2. **Your Understanding:** What you know (so it fills gaps, not repeats)
3. **Scope:** Depth needed, format preferred, examples wanted
4. **Specific Questions:** 2-5 pointed questions you need answered

**BEST PRACTICES:**
- Use 2-3 questions for deep dives on related topics (recommended)
- Use 5-7 questions for broad research across a domain
- Use 8-10 questions for rapid multi-topic scanning
- Group related questions together for coherent research
- More questions = broader coverage but less depth per topic

**EXAMPLE:**
\`\`\`json
{
  "questions": [
    { "question": "What are best practices for MCP server authentication in TypeScript? Cover OAuth2, API keys, session management. Include code examples." },
    { "question": "How do production MCP servers handle rate limiting and error recovery? Looking for patterns from Anthropic, Microsoft, and community servers." }
  ]
}
\`\`\`

Aim for 2-5 questions for optimal balance. Each question runs in parallel.`
    ),
};

export const deepResearchParamsSchema = z.object(deepResearchParamsShape);
export type DeepResearchParams = z.infer<typeof deepResearchParamsSchema>;
