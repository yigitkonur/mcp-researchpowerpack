/**
 * Deep Research Tool Handler - Batch processing with dynamic token allocation
 */

import type { DeepResearchParams } from '../schemas/deep-research.js';
import { ResearchClient, type ResearchResponse } from '../clients/research.js';
import { FileAttachmentService } from '../services/file-attachment.js';
import { RESEARCH } from '../config/index.js';
import { createSimpleError } from '../utils/errors.js';

// Constants
const TOTAL_TOKEN_BUDGET = 32000;
const MIN_QUESTIONS = 2;
const MAX_QUESTIONS = 10;

interface ResearchOptions {
  sessionId?: string;
  logger?: (level: 'info' | 'error' | 'debug', message: string, sessionId: string) => Promise<void>;
}

interface QuestionResult {
  question: string;
  content: string;
  success: boolean;
  error?: string;
  tokensUsed?: number;
}

function calculateTokenAllocation(questionCount: number): number {
  return Math.floor(TOTAL_TOKEN_BUDGET / questionCount);
}

const SYSTEM_PROMPT = `You are an expert research consultant. Provide evidence-based, multi-perspective analysis.

METHODOLOGY:
- SOURCE DIVERSITY: Official docs, papers, blogs, case studies
- CURRENT + HISTORICAL: Latest developments AND context
- MULTIPLE PERSPECTIVES: Different approaches with pros/cons
- EVIDENCE-BASED: Claims backed by citations

FORMAT (high info density):
- CURRENT STATE: Status quo, what we know
- KEY INSIGHTS: Most important findings with evidence
- TRADE-OFFS: Competing priorities honestly analyzed
- PRACTICAL IMPLICATIONS: Real-world application
- WHAT'S CHANGING: Recent developments

Be dense with insights, light on filler. Use examples and citations.`;

export async function handleDeepResearch(
  params: DeepResearchParams,
  options: ResearchOptions = {}
): Promise<{ content: string; structuredContent: object }> {
  const { sessionId, logger } = options;
  const questions = params.questions;

  // Validation
  if (questions.length < MIN_QUESTIONS) {
    return {
      content: `# ❌ Error\n\nMinimum ${MIN_QUESTIONS} research questions required. Received: ${questions.length}`,
      structuredContent: { error: true, message: `Minimum ${MIN_QUESTIONS} questions required` },
    };
  }
  if (questions.length > MAX_QUESTIONS) {
    return {
      content: `# ❌ Error\n\nMaximum ${MAX_QUESTIONS} research questions allowed. Received: ${questions.length}`,
      structuredContent: { error: true, message: `Maximum ${MAX_QUESTIONS} questions allowed` },
    };
  }

  const tokensPerQuestion = calculateTokenAllocation(questions.length);

  if (sessionId && logger) {
    await logger('info', `Starting batch research: ${questions.length} questions, ${tokensPerQuestion.toLocaleString()} tokens/question`, sessionId);
  }

  const client = new ResearchClient();
  const fileService = new FileAttachmentService();
  const results: QuestionResult[] = [];

  // Process all questions in parallel
  const researchPromises = questions.map(async (q, index): Promise<QuestionResult> => {
    try {
      // Enhance question with file attachments if present
      let enhancedQuestion = q.question;
      if (q.file_attachments && q.file_attachments.length > 0) {
        const attachmentsMarkdown = await fileService.formatAttachments(q.file_attachments);
        enhancedQuestion = q.question + attachmentsMarkdown;
      }

      const response = await client.research({
        question: enhancedQuestion,
        systemPrompt: SYSTEM_PROMPT,
        reasoningEffort: RESEARCH.REASONING_EFFORT,
        maxSearchResults: Math.min(RESEARCH.MAX_URLS, 20),
        maxTokens: tokensPerQuestion,
      });

      return {
        question: q.question,
        content: response.content,
        success: true,
        tokensUsed: response.usage?.totalTokens,
      };
    } catch (error) {
      const simpleError = createSimpleError(error);
      return {
        question: q.question,
        content: '',
        success: false,
        error: simpleError.message,
      };
    }
  });

  const allResults = await Promise.all(researchPromises);
  results.push(...allResults);

  // Build markdown output
  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);
  const totalTokens = successful.reduce((sum, r) => sum + (r.tokensUsed || 0), 0);

  let markdown = `# Deep Research Results (${questions.length} questions)\n\n`;
  markdown += `**Token Allocation:** ${tokensPerQuestion.toLocaleString()} tokens/question (${questions.length} questions, ${TOTAL_TOKEN_BUDGET.toLocaleString()} total budget)\n`;
  markdown += `**Status:** ✅ ${successful.length} successful | ❌ ${failed.length} failed | 📊 ${totalTokens.toLocaleString()} tokens used\n\n`;
  markdown += `---\n\n`;

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    markdown += `## Question ${i + 1}: ${r.question.substring(0, 100)}${r.question.length > 100 ? '...' : ''}\n\n`;

    if (r.success) {
      markdown += r.content + '\n\n';
      if (r.tokensUsed) {
        markdown += `_Tokens used: ${r.tokensUsed.toLocaleString()}_\n\n`;
      }
    } else {
      markdown += `**❌ Error:** ${r.error}\n\n`;
    }

    markdown += `---\n\n`;
  }

  if (sessionId && logger) {
    await logger('info', `Research completed: ${successful.length}/${questions.length} successful, ${totalTokens.toLocaleString()} tokens`, sessionId);
  }

  return {
    content: markdown.trim(),
    structuredContent: {
      totalQuestions: questions.length,
      successful: successful.length,
      failed: failed.length,
      tokensPerQuestion,
      totalTokensUsed: totalTokens,
      results,
    },
  };
}
