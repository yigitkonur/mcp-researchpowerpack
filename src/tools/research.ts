/**
 * Deep Research Tool Handler - Batch processing with dynamic token allocation
 * Implements robust error handling that NEVER crashes
 */

import type { MCPServer } from 'mcp-use/server';

import { getCapabilities, getMissingEnvMessage, RESEARCH, RESEARCH_PROMPTS } from '../config/index.js';
import {
  deepResearchOutputSchema,
  deepResearchParamsSchema,
  type DeepResearchOutput,
  type DeepResearchParams,
} from '../schemas/deep-research.js';
import { ResearchClient } from '../clients/research.js';
import { FileAttachmentService } from '../services/file-attachment.js';
import { classifyError } from '../utils/errors.js';
import { pMap } from '../utils/concurrency.js';
import {
  mcpLog,
  formatSuccess,
  formatError,
  formatBatchHeader,
  formatDuration,
  truncateText,
  TOKEN_BUDGETS,
  calculateTokenAllocation,
} from './utils.js';
import {
  createToolReporter,
  NOOP_REPORTER,
  toolFailure,
  toolSuccess,
  toToolResponse,
  type ToolExecutionResult,
  type ToolReporter,
} from './mcp-helpers.js';

// Constants
const MIN_QUESTIONS = 1; // Allow single question for flexibility
const MAX_QUESTIONS = 10;

interface QuestionResult {
  question: string;
  content: string;
  success: boolean;
  error?: string;
  tokensUsed?: number;
}

const SYSTEM_PROMPT = `Expert research engine. Multi-source: docs, papers, blogs, case studies. Cite inline [source].

FORMAT RULES:
- For comparisons/features/structured data → use markdown table |Col|Col|Col|
- No intro, no greeting, no conclusion
- Every claim must cite a source inline [source]
- Every sentence = fact, data point, or actionable insight
- First line of output = content (never a preamble)`;

// Compression suffix is kept in runtime config.
function getResearchSuffix(): string {
  return RESEARCH_PROMPTS.SUFFIX;
}

function wrapQuestionWithCompression(question: string): string {
  return `${question}\n\n${getResearchSuffix()}`;
}

// --- Helpers ---

function validateQuestionCount(
  count: number,
): { code: string; message: string; howToFix: string[] } | null {
  if (count < MIN_QUESTIONS) {
    return {
      code: 'MIN_QUESTIONS',
      message: `Minimum ${MIN_QUESTIONS} research question(s) required. Received: ${count}`,
      howToFix: ['Add at least one question with detailed context following the template: WHAT I NEED, WHY, WHAT I KNOW, SPECIFIC QUESTIONS'],
    };
  }
  if (count > MAX_QUESTIONS) {
    return {
      code: 'MAX_QUESTIONS',
      message: `Maximum ${MAX_QUESTIONS} research questions allowed. Received: ${count}`,
      howToFix: [`Remove ${count - MAX_QUESTIONS} question(s)`],
    };
  }
  return null;
}

async function enhanceQuestionWithAttachments(
  question: string,
  fileAttachments: DeepResearchParams['questions'][number]['file_attachments'],
  fileService: FileAttachmentService,
  index: number,
): Promise<string> {
  if (!fileAttachments || fileAttachments.length === 0) return question;
  try {
    const attachmentsMarkdown = await fileService.formatAttachments(fileAttachments);
    return question + attachmentsMarkdown;
  } catch {
    mcpLog('warning', `Failed to process attachments for question ${index + 1}`, 'research');
    return question;
  }
}

async function executeResearchQuestions(
  questions: DeepResearchParams['questions'],
  client: ResearchClient,
  fileService: FileAttachmentService,
  tokensPerQuestion: number,
  reporter: ToolReporter,
): Promise<QuestionResult[]> {
  let completed = 0;

  return pMap(questions, async (q, index): Promise<QuestionResult> => {
    try {
      let enhancedQuestion = await enhanceQuestionWithAttachments(
        q.question, q.file_attachments, fileService, index,
      );
      enhancedQuestion = wrapQuestionWithCompression(enhancedQuestion);

      const response = await client.research({
        question: enhancedQuestion,
        systemPrompt: SYSTEM_PROMPT,
        reasoningEffort: RESEARCH.REASONING_EFFORT,
        maxSearchResults: Math.min(RESEARCH.MAX_URLS, 20),
        maxTokens: tokensPerQuestion,
      });

      const result = response.error
        ? { question: q.question, content: response.content || '', success: false, error: response.error.message }
        : {
        question: q.question,
        content: response.content || '',
        success: !!response.content,
        tokensUsed: response.usage?.totalTokens,
        error: response.content ? undefined : 'Empty response received',
      };

      completed += 1;
      await reporter.progress(
        30 + Math.round((completed / questions.length) * 55),
        100,
        `Completed research question ${completed}/${questions.length}`,
      );

      return result;
    } catch (error) {
      const structuredError = classifyError(error);
      completed += 1;
      await reporter.progress(
        30 + Math.round((completed / questions.length) * 55),
        100,
        `Completed research question ${completed}/${questions.length}`,
      );
      return { question: q.question, content: '', success: false, error: structuredError.message };
    }
  }, 3);
}

function buildQuestionsData(results: QuestionResult[]): string {
  const sections: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (!r) continue;
    const preview = truncateText(r.question, 100);
    sections.push(`## Question ${i + 1}: ${preview}\n`);

    if (r.success) {
      sections.push(r.content);
      if (r.tokensUsed) sections.push(`\n*Tokens used: ${r.tokensUsed.toLocaleString()}*`);
    } else {
      sections.push(`**❌ Error:** ${r.error}`);
    }
    sections.push('\n---\n');
  }
  return sections.join('\n');
}

function formatResearchOutput(
  results: QuestionResult[],
  totalQuestions: number,
  tokensPerQuestion: number,
  executionTime: number,
): ToolExecutionResult<DeepResearchOutput> {
  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);
  const totalTokens = successful.reduce((sum, r) => sum + (r.tokensUsed || 0), 0);

  const batchHeader = formatBatchHeader({
    title: `Deep Research Results`,
    totalItems: totalQuestions,
    successful: successful.length,
    failed: failed.length,
    tokensPerItem: tokensPerQuestion,
    extras: { 'Total tokens used': totalTokens.toLocaleString() },
  });

  const formattedContent = formatSuccess({
    title: `Research Complete (${successful.length}/${totalQuestions})`,
    summary: batchHeader,
    data: buildQuestionsData(results),
  });

  return toolSuccess(formattedContent, {
    totalQuestions,
    successful: successful.length,
    failed: failed.length,
    tokensPerQuestion,
    totalTokensUsed: totalTokens,
    results,
  });
}

/**
 * Handle deep research request
 * NEVER throws - always returns a valid response
 */
export async function handleDeepResearch(
  params: DeepResearchParams,
  reporter: ToolReporter = NOOP_REPORTER,
): Promise<ToolExecutionResult<DeepResearchOutput>> {
  const startTime = Date.now();
  const questions = params.questions || [];

  const validationError = validateQuestionCount(questions.length);
  if (validationError) {
    return toolFailure(formatError({ ...validationError, toolName: 'deep-research' }));
  }

  const tokensPerQuestion = calculateTokenAllocation(questions.length, TOKEN_BUDGETS.RESEARCH);
  mcpLog('info', `Starting batch research: ${questions.length} questions, ${tokensPerQuestion.toLocaleString()} tokens/question`, 'research');
  await reporter.log(
    'info',
    `Starting deep research for ${questions.length} question(s) with ${tokensPerQuestion.toLocaleString()} tokens/question`,
  );
  await reporter.progress(15, 100, 'Initializing research client');

  let client: ResearchClient;
  try {
    client = new ResearchClient();
  } catch (error) {
    const err = classifyError(error);
    return toolFailure(
      formatError({
        code: 'CLIENT_INIT_FAILED',
        message: `Failed to initialize research client: ${err.message}`,
        toolName: 'deep-research',
        howToFix: ['Check OPENROUTER_API_KEY is set'],
        alternatives: [
          'web-search(keywords=["topic best practices", "topic guide", "topic comparison 2025"]) — uses Serper API (different key), search for information directly',
          'search-reddit(queries=["topic recommendations", "topic experience", "topic discussion"]) — uses Serper API, get community perspective',
          'scrape-links(urls=[...any relevant URLs...], use_llm=true) — if you have URLs, scrape them for content (uses Firecrawl + OpenRouter, may also fail if OpenRouter key is the issue)',
        ],
      }),
    );
  }

  const fileService = new FileAttachmentService();
  await reporter.progress(25, 100, 'Dispatching research questions');
  const results = await executeResearchQuestions(
    questions,
    client,
    fileService,
    tokensPerQuestion,
    reporter,
  );
  const executionTime = Date.now() - startTime;

  mcpLog('info', `Research completed: ${results.filter(r => r.success).length}/${questions.length} successful, ${results.filter(r => r.success).reduce((s, r) => s + (r.tokensUsed || 0), 0).toLocaleString()} tokens`, 'research');
  await reporter.log(
    'info',
    `Research completed with ${results.filter(r => r.success).length} successful question(s)`,
  );

  return formatResearchOutput(results, questions.length, tokensPerQuestion, executionTime);
}

export function registerDeepResearchTool(server: MCPServer): void {
  server.tool(
    {
      name: 'deep-research',
      title: 'Deep Research',
      description:
        'Run 1-10 parallel deep research questions with optional file attachments and source-grounded synthesis.',
      schema: deepResearchParamsSchema,
      outputSchema: deepResearchOutputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (args, ctx) => {
      if (!getCapabilities().deepResearch) {
        return toToolResponse(toolFailure(getMissingEnvMessage('deepResearch')));
      }

      const reporter = createToolReporter(ctx, 'deep-research');
      const result = await handleDeepResearch(args, reporter);

      await reporter.progress(100, 100, result.isError ? 'Research failed' : 'Research complete');
      return toToolResponse(result);
    },
  );
}
