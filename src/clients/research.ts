/**
 * Deep Research Client
 * Handles research API requests with web search capabilities
 */

import OpenAI from 'openai';
import { RESEARCH } from '../config/index.js';

export interface ResearchParams {
  question: string;
  systemPrompt?: string;
  reasoningEffort?: 'low' | 'medium' | 'high';
  maxSearchResults?: number;
  maxTokens?: number;
  temperature?: number;
  responseFormat?: { type: 'json_object' | 'text' };
}

export interface ResearchResponse {
  id: string;
  model: string;
  created: number;
  content: string;
  finishReason?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    sourcesUsed?: number;
  };
  annotations?: Array<{
    type: 'url_citation';
    url: string;
    title: string;
    startIndex: number;
    endIndex: number;
  }>;
}

export class ResearchClient {
  private client: OpenAI;

  constructor() {
    if (!RESEARCH.API_KEY) {
      throw new Error('OPENROUTER_API_KEY is required for research');
    }

    this.client = new OpenAI({
      baseURL: RESEARCH.BASE_URL,
      apiKey: RESEARCH.API_KEY,
      timeout: RESEARCH.TIMEOUT_MS,
    });
  }

  async research(params: ResearchParams): Promise<ResearchResponse> {
    const {
      question,
      systemPrompt,
      reasoningEffort = RESEARCH.REASONING_EFFORT,
      maxSearchResults = RESEARCH.MAX_URLS,
      maxTokens = 32000,
      temperature = 0.3,
      responseFormat,
    } = params;

    const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: question });

    const requestPayload: Record<string, unknown> = {
      model: RESEARCH.MODEL,
      messages,
      temperature,
      reasoning_effort: reasoningEffort,
      max_completion_tokens: maxTokens,
      search_parameters: {
        mode: 'on',
        max_search_results: Math.min(maxSearchResults, 30),
        return_citations: true,
        sources: [{ type: 'web' }],
      },
    };

    if (responseFormat) {
      requestPayload.response_format = responseFormat;
    }

    if (process.env.MCP_DEBUG === 'true') {
      console.error('[DEBUG] Research Request:', JSON.stringify(requestPayload, null, 2));
    }

    try {
      const response = await this.client.chat.completions.create(requestPayload as any);
      const choice = response.choices?.[0];
      const message = choice?.message as any;

      return {
        id: response.id,
        model: response.model,
        created: response.created,
        content: message?.content || '',
        finishReason: choice?.finish_reason,
        usage: response.usage ? {
          promptTokens: response.usage.prompt_tokens,
          completionTokens: response.usage.completion_tokens,
          totalTokens: response.usage.total_tokens,
          sourcesUsed: (response.usage as any).num_sources_used,
        } : undefined,
        annotations: message?.annotations?.map((a: any) => ({
          type: 'url_citation' as const,
          url: a.url_citation?.url,
          title: a.url_citation?.title,
          startIndex: a.url_citation?.start_index,
          endIndex: a.url_citation?.end_index,
        })),
      };
    } catch (error: unknown) {
      const err = error as { message?: string; response?: { data?: unknown; status?: number } };
      console.error('[ERROR] Research request failed:', err.message);
      if (err.response) {
        console.error('[ERROR] Response:', JSON.stringify(err.response.data, null, 2));
      }
      throw error;
    }
  }
}
