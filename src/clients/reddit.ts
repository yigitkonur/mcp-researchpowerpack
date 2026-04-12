/**
 * Reddit OAuth API Client
 * Fetches posts and comments sorted by score (most upvoted first)
 * Implements robust error handling that NEVER crashes
 */

import { Logger } from 'mcp-use';

import { REDDIT, CONCURRENCY } from '../config/index.js';
import { USER_AGENT_VERSION } from '../version.js';
import { calculateBackoff } from '../utils/retry.js';
import {
  classifyError,
  fetchWithTimeout,
  sleep,
  ErrorCode,
  type StructuredError,
} from '../utils/errors.js';
import { pMap, pMapSettled } from '../utils/concurrency.js';
import { mcpLog } from '../utils/logger.js';

// ── Constants ──

const REDDIT_TOKEN_URL = 'https://www.reddit.com/api/v1/access_token' as const;
const REDDIT_API_BASE = 'https://oauth.reddit.com' as const;
const TOKEN_EXPIRY_MS = 55_000 as const; // 55 second expiry (conservative)

// ── Data Interfaces ──

interface Post {
  readonly title: string;
  readonly author: string;
  readonly subreddit: string;
  readonly body: string;
  readonly score: number;
  readonly commentCount: number;
  readonly url: string;
  readonly created: Date;
  readonly flair?: string;
  readonly isNsfw: boolean;
  readonly isPinned: boolean;
}

export interface Comment {
  readonly author: string;
  readonly body: string;
  readonly score: number;
  readonly depth: number;
  readonly isOP: boolean;
}

export interface PostResult {
  readonly post: Post;
  readonly comments: Comment[];
  readonly actualComments: number;
}

interface BatchPostResult {
  readonly results: Map<string, PostResult | Error>;
  readonly batchesProcessed: number;
  readonly totalPosts: number;
  readonly rateLimitHits: number;
}

/** Reddit API "Listing" wrapper */
interface RedditListing<T> {
  readonly kind: string;
  readonly data: {
    readonly children: ReadonlyArray<{ readonly kind: string; readonly data: T }>;
    readonly after?: string;
    readonly before?: string;
  };
}

/** Reddit post data from API */
interface RedditPostData {
  readonly title: string;
  readonly selftext: string;
  readonly selftext_html?: string;
  readonly author: string;
  readonly subreddit: string;
  readonly score: number;
  readonly upvote_ratio: number;
  readonly num_comments: number;
  readonly created_utc: number;
  readonly url: string;
  readonly permalink: string;
  readonly is_self: boolean;
  readonly over_18: boolean;
  readonly stickied: boolean;
  readonly link_flair_text?: string;
  readonly [key: string]: unknown;
}

/** Reddit comment data from API */
interface RedditCommentData {
  readonly body?: string;
  readonly author?: string;
  readonly score?: number;
  readonly created_utc?: number;
  readonly replies?: RedditListing<RedditCommentData> | string;
  readonly [key: string]: unknown;
}

type RedditPostResponse = [RedditListing<RedditPostData>, RedditListing<RedditCommentData>];

/** Max comments to fetch per post from Reddit API */
/** Reddit API caps at 500 comments per request */
const FETCH_LIMIT = 500;

// ============================================================================
// Module-Level Token Cache (shared across all RedditClient instances)
// ============================================================================
let cachedToken: string | null = null;
let cachedTokenExpiry = 0;

// Token cache logging only when DEBUG env is set
const DEBUG_TOKEN_CACHE = process.env.DEBUG_REDDIT === 'true';
const clientLogger = Logger.get('reddit-client');

// Pending auth promise for deduplicating concurrent auth calls
let pendingAuthPromise: Promise<string | null> | null = null;

// ── Decomposed Helpers ──

/**
 * Fetch a Reddit post's JSON from the API
 */
async function fetchRedditJson(
  sub: string,
  id: string,
  token: string,
  userAgent: string,
): Promise<RedditPostResponse> {
  const limit = Math.min(FETCH_LIMIT, 500);
  const apiUrl = `${REDDIT_API_BASE}/r/${sub}/comments/${id}?sort=top&limit=${limit}&depth=10&raw_json=1`;

  const res = await fetchWithTimeout(apiUrl, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'User-Agent': userAgent,
    },
    timeoutMs: 30000,
  });

  if (res.status === 429) {
    const err = new Error('Rate limited by Reddit API');
    (err as Error & { status: number }).status = 429;
    throw err;
  }

  if (res.status === 404) {
    throw new Error(`Post not found: /r/${sub}/comments/${id}`);
  }

  if (!res.ok) {
    const err = new Error(`Reddit API error: ${res.status}`);
    (err as Error & { status: number }).status = res.status;
    throw err;
  }

  try {
    return await res.json() as RedditPostResponse;
  } catch {
    throw new Error('Failed to parse Reddit API response');
  }
}

/**
 * Extract structured post data from a Reddit listing
 */
function parsePostData(
  postListing: RedditListing<RedditPostData>,
  sub: string,
): Post {
  const p = postListing?.data?.children?.[0]?.data;
  if (!p) {
    throw new Error(`Post data not found in response for /r/${sub}`);
  }

  return {
    title: p.title || 'Untitled',
    author: p.author || '[deleted]',
    subreddit: p.subreddit || sub,
    body: formatBody(p),
    score: p.score || 0,
    commentCount: p.num_comments || 0,
    url: `https://reddit.com${p.permalink || ''}`,
    created: new Date((p.created_utc || 0) * 1000),
    flair: p.link_flair_text || undefined,
    isNsfw: p.over_18 || false,
    isPinned: p.stickied || false,
  };
}

function formatBody(p: RedditPostData): string {
  if (p.selftext?.trim()) return p.selftext;
  if (p.is_self) return '';
  if (p.url) return `**Link:** ${p.url}`;
  return '';
}

/** Safety cap on comment tree recursion depth */
const MAX_COMMENT_DEPTH = 15 as const;

/**
 * Extract and sort comments from a Reddit comment listing
 */
function parseCommentTree(
  commentListing: RedditListing<RedditCommentData>,
  opAuthor: string,
): Comment[] {
  const result: Comment[] = [];

  const extract = (items: ReadonlyArray<{ readonly kind: string; readonly data: RedditCommentData }>, depth = 0): void => {
    if (depth > MAX_COMMENT_DEPTH) return;
    const sorted = [...items].sort((a, b) => (b.data?.score || 0) - (a.data?.score || 0));

    for (const c of sorted) {
      if (c.kind !== 't1' || !c.data?.author || c.data.author === '[deleted]') continue;

      result.push({
        author: c.data.author,
        body: c.data.body || '',
        score: c.data.score || 0,
        depth,
        isOP: c.data.author === opAuthor,
      });

      if (typeof c.data.replies === 'object' && c.data.replies?.data?.children) {
        extract(c.data.replies.data.children, depth + 1);
      }
    }
  };

  extract(commentListing?.data?.children || []);
  return result;
}

// ── Batch Helpers ──

/**
 * Process a single batch of Reddit URLs, returning results keyed by URL
 */
async function processBatch(
  client: RedditClient,
  batchUrls: string[],
): Promise<{ results: Map<string, PostResult | Error>; rateLimitHits: number }> {
  const results = new Map<string, PostResult | Error>();
  let rateLimitHits = 0;

  const batchResults = await pMapSettled(
    batchUrls,
    url => client.getPost(url),
    CONCURRENCY.REDDIT,
  );

  for (let i = 0; i < batchResults.length; i++) {
    const result = batchResults[i];
    if (!result) continue;
    const url = batchUrls[i] ?? '';

    if (result.status === 'fulfilled') {
      results.set(url, result.value);
    } else {
      const errorMsg = result.reason?.message || String(result.reason);
      if (errorMsg.includes('429') || errorMsg.includes('rate')) rateLimitHits++;
      results.set(url, new Error(errorMsg));
    }
  }

  return { results, rateLimitHits };
}

// ── RedditClient Class ──

export class RedditClient {
  private userAgent = `script:${USER_AGENT_VERSION} (by /u/research-powerpack)`;

  constructor(private clientId: string, private clientSecret: string) {}

  /**
   * Authenticate with Reddit API with retry logic
   * Uses module-level token cache and promise deduplication to prevent
   * concurrent auth calls from firing multiple token requests
   * Returns null on failure instead of throwing
   */
  private async auth(): Promise<string | null> {
    if (cachedToken && Date.now() < cachedTokenExpiry - TOKEN_EXPIRY_MS) {
      if (DEBUG_TOKEN_CACHE) clientLogger.debug('Token cache HIT');
      return cachedToken;
    }

    if (pendingAuthPromise) {
      if (DEBUG_TOKEN_CACHE) clientLogger.debug('Auth already in flight, awaiting...');
      return pendingAuthPromise;
    }

    pendingAuthPromise = this.performAuth();
    try {
      return await pendingAuthPromise;
    } finally {
      pendingAuthPromise = null;
    }
  }

  private async performAuth(): Promise<string | null> {
    if (DEBUG_TOKEN_CACHE) clientLogger.debug('Token cache MISS - authenticating');

    const credentials = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetchWithTimeout(REDDIT_TOKEN_URL, {
          method: 'POST',
          headers: {
            'Authorization': `Basic ${credentials}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': this.userAgent,
          },
          body: 'grant_type=client_credentials',
          timeoutMs: 15000,
        });

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          mcpLog('error', `Auth failed (${res.status}): ${text}`, 'reddit');

          if (res.status === 401 || res.status === 403) {
            cachedToken = null;
            cachedTokenExpiry = 0;
            return null;
          }

          if (res.status >= 500 && attempt < 2) {
            await sleep(calculateBackoff(attempt));
            continue;
          }

          return null;
        }

        const data = await res.json() as { access_token?: string; expires_in?: number };
        if (!data.access_token) {
          mcpLog('error', 'Auth response missing access_token', 'reddit');
          return null;
        }

        cachedToken = data.access_token;
        cachedTokenExpiry = Date.now() + (data.expires_in || 3600) * 1000;
        return cachedToken;

      } catch (error) {
        const err = classifyError(error);
        mcpLog('error', `Auth error (attempt ${attempt + 1}): ${err.message}`, 'reddit');

        if (err.code === ErrorCode.AUTH_ERROR) {
          cachedToken = null;
          cachedTokenExpiry = 0;
        }

        if (attempt < 2 && err.retryable) {
          await sleep(calculateBackoff(attempt));
          continue;
        }

        return null;
      }
    }

    return null;
  }

  private parseUrl(url: string): { sub: string; id: string } | null {
    const m = url.match(/reddit\.com\/r\/([^\/]+)\/comments\/([a-z0-9]+)/i);
    return m ? { sub: m[1]!, id: m[2]! } : null;
  }

  /**
   * Get a single Reddit post with comments
   * Returns PostResult or throws Error (for use with Promise.allSettled)
   */
  async getPost(url: string): Promise<PostResult> {
    const parsed = this.parseUrl(url);
    if (!parsed) {
      throw new Error(`Invalid Reddit URL format: ${url}`);
    }

    const token = await this.auth();
    if (!token) {
      throw new Error('Reddit authentication failed - check credentials');
    }

    let lastError: StructuredError | null = null;

    for (let attempt = 0; attempt < REDDIT.RETRY_COUNT; attempt++) {
      try {
        const data = await fetchRedditJson(parsed.sub, parsed.id, token, this.userAgent);
        const [postListing, commentListing] = data;

        const post = parsePostData(postListing, parsed.sub);
        const comments = parseCommentTree(commentListing, post.author);

        return { post, comments, actualComments: post.commentCount };

      } catch (error) {
        lastError = classifyError(error);

        // Rate limited — always retry with backoff
        const status = (error as Error & { status?: number }).status;
        if (status === 429) {
          const delay = REDDIT.RETRY_DELAYS[attempt] || 32000;
          mcpLog('warning', `Rate limited. Retry ${attempt + 1}/${REDDIT.RETRY_COUNT} after ${delay}ms`, 'reddit');
          await sleep(delay);
          continue;
        }

        if (!lastError.retryable) {
          throw error instanceof Error ? error : new Error(lastError.message);
        }

        if (attempt < REDDIT.RETRY_COUNT - 1) {
          const delay = REDDIT.RETRY_DELAYS[attempt] || 2000;
          mcpLog('warning', `${lastError.code}: ${lastError.message}. Retry ${attempt + 1}/${REDDIT.RETRY_COUNT}`, 'reddit');
          await sleep(delay);
        }
      }
    }

    throw new Error(lastError?.message || 'Failed to fetch Reddit post after retries');
  }

  async batchGetPosts(
    urls: string[],
    fetchComments = true,
    onBatchComplete?: (batchNum: number, totalBatches: number, processed: number) => void,
  ): Promise<BatchPostResult> {
    const allResults = new Map<string, PostResult | Error>();
    let rateLimitHits = 0;

    const totalBatches = Math.ceil(urls.length / REDDIT.BATCH_SIZE);
    mcpLog('info', `Fetching ${urls.length} posts in ${totalBatches} batch(es), up to ${FETCH_LIMIT} comments/post`, 'reddit');

    for (let batchNum = 0; batchNum < totalBatches; batchNum++) {
      const startIdx = batchNum * REDDIT.BATCH_SIZE;
      const batchUrls = urls.slice(startIdx, startIdx + REDDIT.BATCH_SIZE);

      mcpLog('info', `Batch ${batchNum + 1}/${totalBatches} (${batchUrls.length} posts)`, 'reddit');

      const batchResult = await processBatch(this, batchUrls);
      for (const [url, result] of batchResult.results) {
        allResults.set(url, result);
      }
      rateLimitHits += batchResult.rateLimitHits;

      try {
        onBatchComplete?.(batchNum + 1, totalBatches, allResults.size);
      } catch (callbackError) {
        mcpLog('error', `onBatchComplete callback error: ${callbackError}`, 'reddit');
      }

      mcpLog('info', `Batch ${batchNum + 1} complete (${allResults.size}/${urls.length})`, 'reddit');

      if (batchNum < totalBatches - 1) {
        await sleep(500);
      }
    }

    return { results: allResults, batchesProcessed: totalBatches, totalPosts: urls.length, rateLimitHits };
  }
}
