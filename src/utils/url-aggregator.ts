/**
 * URL Aggregator Utility
 * Aggregates search results across multiple queries, calculates CTR-weighted scores,
 * and generates consensus-based rankings.
 */

import { CTR_WEIGHTS } from '../config/index.js';
import type { KeywordSearchResult, RedditSearchResult } from '../clients/search.js';

/** Minimum frequency for web search consensus marking */
const WEB_CONSENSUS_THRESHOLD = 3 as const;

/** Minimum frequency for Reddit consensus marking (lower due to fewer overlapping results) */
const REDDIT_CONSENSUS_THRESHOLD = 2 as const;

/** Minimum weight assigned to positions beyond top 10 */
const MIN_BEYOND_TOP10_WEIGHT = 0 as const;

/** Weight decay per position beyond top 10 */
const BEYOND_TOP10_DECAY = 0.5 as const;

/** Base position for beyond-top-10 weight calculation */
const BEYOND_TOP10_BASE = 10 as const;

/** Default minimum consensus URLs before lowering threshold (web search) */
const DEFAULT_MIN_CONSENSUS_URLS = 5 as const;

/** Default minimum consensus URLs before lowering threshold (Reddit) */
const DEFAULT_REDDIT_MIN_CONSENSUS_URLS = 3 as const;

/** High consensus frequency threshold for enhanced output labeling */
const HIGH_CONSENSUS_THRESHOLD = 4 as const;

/**
 * Aggregated URL data structure
 */
interface AggregatedUrl {
  readonly url: string;
  title: string;
  snippet: string;
  frequency: number;
  readonly positions: number[];
  readonly queries: string[];
  bestPosition: number;
  totalScore: number;
}

/**
 * Ranked URL with normalized score
 */
interface RankedUrl {
  readonly url: string;
  readonly title: string;
  readonly snippet: string;
  readonly rank: number;
  readonly score: number;
  readonly frequency: number;
  readonly positions: number[];
  readonly queries: string[];
  readonly bestPosition: number;
  readonly isConsensus: boolean;
}

/**
 * Aggregation result containing all processed data
 */
interface AggregationResult {
  readonly rankedUrls: RankedUrl[];
  readonly totalUniqueUrls: number;
  readonly totalQueries: number;
  readonly frequencyThreshold: number;
  readonly thresholdNote?: string;
}

/**
 * Get CTR weight for a position (1-10)
 * Positions beyond 10 get minimal weight
 */
function getCtrWeight(position: number): number {
  if (position >= 1 && position <= 10) {
    return CTR_WEIGHTS[position] ?? 0;
  }
  // Positions beyond 10 get diminishing returns
  return Math.max(MIN_BEYOND_TOP10_WEIGHT, BEYOND_TOP10_BASE - (position - BEYOND_TOP10_BASE) * BEYOND_TOP10_DECAY);
}

/**
 * Aggregate results from multiple searches
 * Flattens all results, deduplicates by URL, and tracks frequency/positions
 */
function aggregateResults(searches: KeywordSearchResult[]): Map<string, AggregatedUrl> {
  const urlMap = new Map<string, AggregatedUrl>();

  for (const search of searches) {
    for (const result of search.results) {
      const normalizedUrl = normalizeUrl(result.link);
      const existing = urlMap.get(normalizedUrl);

      if (existing) {
        existing.frequency += 1;
        existing.positions.push(result.position);
        existing.queries.push(search.keyword);
        const prevBest = existing.bestPosition;
        existing.bestPosition = Math.min(existing.bestPosition, result.position);
        existing.totalScore += getCtrWeight(result.position);
        // Keep best title/snippet (from highest ranking position)
        if (result.position < prevBest) {
          existing.title = result.title;
          existing.snippet = result.snippet;
        }
      } else {
        urlMap.set(normalizedUrl, {
          url: result.link,
          title: result.title,
          snippet: result.snippet,
          frequency: 1,
          positions: [result.position],
          queries: [search.keyword],
          bestPosition: result.position,
          totalScore: getCtrWeight(result.position),
        });
      }
    }
  }

  return urlMap;
}

/**
 * Normalize URL for deduplication
 * Removes trailing slashes, www prefix, and normalizes protocol
 */
function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    let host = parsed.hostname.replace(/^www\./, '');
    let path = parsed.pathname.replace(/\/$/, '') || '/';
    return `${host}${path}${parsed.search}`.toLowerCase();
  } catch {
    return url.toLowerCase().replace(/\/$/, '');
  }
}

/**
 * Count URLs meeting a frequency threshold
 */
function countByFrequency(
  urlMap: Map<string, AggregatedUrl>,
  minFrequency: number
): number {
  let count = 0;
  for (const url of urlMap.values()) {
    if (url.frequency >= minFrequency) count++;
  }
  return count;
}

/**
 * Calculate weighted scores and normalize to 100.0
 * Returns ALL URLs sorted by score with rank assignments and consensus marking
 */
function calculateWeightedScores(urls: AggregatedUrl[], consensusThreshold: number): RankedUrl[] {
  if (urls.length === 0) return [];

  // Sort by total score descending
  const sorted = [...urls].sort((a, b) => b.totalScore - a.totalScore);

  // Find max score for normalization
  const maxScore = sorted[0]!.totalScore;

  // Map to ranked URLs with normalized scores
  return sorted.map((url, index) => ({
    url: url.url,
    title: url.title,
    snippet: url.snippet,
    rank: index + 1,
    score: maxScore > 0 ? (url.totalScore / maxScore) * 100 : 0,
    frequency: url.frequency,
    positions: url.positions,
    queries: url.queries,
    bestPosition: url.bestPosition,
    isConsensus: url.frequency >= consensusThreshold,
  }));
}

/**
 * Mark consensus status for a URL
 * Returns "✓" if frequency >= threshold, else "✗"
 */
export function markConsensus(frequency: number): string {
  return frequency >= WEB_CONSENSUS_THRESHOLD ? '✓' : '✗';
}

/**
 * Generate justification for why a URL is ranked at its position
 */
function generateJustification(url: RankedUrl, rank: number): string {
  const parts: string[] = [];
  
  if (url.frequency >= HIGH_CONSENSUS_THRESHOLD) {
    parts.push(`Appeared in ${url.frequency} different searches showing strong cross-query relevance`);
  } else if (url.frequency >= WEB_CONSENSUS_THRESHOLD) {
    parts.push(`Found across ${url.frequency} searches indicating solid topical coverage`);
  } else {
    parts.push(`Appeared in ${url.frequency} search${url.frequency > 1 ? 'es' : ''}`);
  }
  
  if (url.bestPosition === 1) {
    parts.push('ranked #1 in at least one search');
  } else if (url.bestPosition <= 3) {
    parts.push(`best position was top-3 (#${url.bestPosition})`);
  }
  
  return parts.join(', ') + '.';
}

/**
 * Generate enhanced narrative output for consensus URLs
 */
export function generateEnhancedOutput(
  rankedUrls: RankedUrl[],
  allKeywords: string[],
  totalUniqueUrls: number,
  frequencyThreshold: number,
  thresholdNote?: string
): string {
  const lines: string[] = [];
  
  // Header
  const consensusCount = rankedUrls.filter(u => u.isConsensus).length;
  lines.push(`## Aggregated Search Results (${allKeywords.length} Queries → ${rankedUrls.length} Unique URLs)`);
  lines.push('');
  lines.push(`Based on ${allKeywords.length} distinct searches, we found **${rankedUrls.length} unique resources** (${consensusCount} appear in multiple queries).`);
  lines.push('');

  if (thresholdNote) {
    lines.push(`> ${thresholdNote}`);
    lines.push('');
  }

  // All ranked resources
  lines.push('### 🥇 Ranked Resources');
  lines.push('');

  for (const url of rankedUrls) {
    const highConsensus = url.frequency >= HIGH_CONSENSUS_THRESHOLD ? ' ⭐ HIGHEST CONSENSUS' : url.isConsensus ? ' ✓ CONSENSUS' : '';
    lines.push(`#### #${url.rank}: ${url.title} (Score: ${url.score.toFixed(1)})${highConsensus}`);
    
    // Appeared in queries
    const queriesList = url.queries.map(q => `"${q}"`).join(', ');
    lines.push(`- **Appeared in:** ${url.frequency} queries (${queriesList})`);
    
    // Best ranking
    lines.push(`- **Best ranking:** Position ${url.bestPosition}`);
    
    // Description
    lines.push(`- **Description:** ${url.snippet}`);
    
    // Justification
    lines.push(`- **Why it's #${url.rank}:** ${generateJustification(url, url.rank)}`);
    
    // URL
    lines.push(`- **URL:** ${url.url}`);
    lines.push('');
  }
  
  // Metadata section
  lines.push('---');
  lines.push('');
  lines.push('### 📈 Metadata');
  lines.push('');
  lines.push(`- **Total Queries:** ${allKeywords.length} (${allKeywords.join(', ')})`);
  
  // Sort all URLs by frequency for the unique URLs list
  const sortedByFreq = [...rankedUrls].sort((a, b) => b.frequency - a.frequency);
  const urlFreqList = sortedByFreq
    .map(u => `${u.url} (${u.frequency}x)`)
    .join(', ');
  
  lines.push(`- **Unique URLs Found:** ${totalUniqueUrls} — top by frequency: ${urlFreqList}`);
  lines.push(`- **Consensus Threshold:** ≥${frequencyThreshold} appearances`);
  lines.push('');

  return lines.join('\n');
}

/**
 * Full aggregation pipeline — returns ALL URLs ranked by CTR score.
 * Determines a consensus threshold (≥3, ≥2, or ≥1) for labeling, but never
 * drops URLs below the threshold. Every collected URL appears in the output.
 */
export function aggregateAndRank(
  searches: KeywordSearchResult[],
  minConsensusUrls: number = DEFAULT_MIN_CONSENSUS_URLS
): AggregationResult {
  const urlMap = aggregateResults(searches);
  const totalUniqueUrls = urlMap.size;
  const totalQueries = searches.length;

  // Determine consensus threshold for labeling (not filtering)
  const thresholds = [3, 2, 1];
  let usedThreshold = 1;
  let thresholdNote: string | undefined;

  for (const threshold of thresholds) {
    const count = countByFrequency(urlMap, threshold);
    if (count >= minConsensusUrls || threshold === 1) {
      usedThreshold = threshold;
      if (threshold < 3) {
        thresholdNote = `Note: Consensus threshold set to ≥${threshold} due to result diversity.`;
      }
      break;
    }
  }

  // Rank ALL URLs, marking consensus based on determined threshold
  const allUrls = [...urlMap.values()];
  const rankedUrls = calculateWeightedScores(allUrls, usedThreshold);

  return {
    rankedUrls,
    totalUniqueUrls,
    totalQueries,
    frequencyThreshold: usedThreshold,
    thresholdNote,
  };
}

/**
 * Build URL lookup map for quick consensus checking during result formatting
 */
export function buildUrlLookup(rankedUrls: RankedUrl[]): Map<string, RankedUrl> {
  const lookup = new Map<string, RankedUrl>();
  
  for (const url of rankedUrls) {
    const normalized = normalizeUrl(url.url);
    lookup.set(normalized, url);
    // Also store original URL
    lookup.set(url.url.toLowerCase(), url);
  }

  return lookup;
}

/**
 * Look up a URL in the ranked results
 */
export function lookupUrl(url: string, lookup: Map<string, RankedUrl>): RankedUrl | undefined {
  const normalized = normalizeUrl(url);
  return lookup.get(normalized) || lookup.get(url.toLowerCase());
}

// ============================================================================
// Reddit-Specific Aggregation
// ============================================================================

/**
 * Aggregated Reddit URL data structure
 */
interface AggregatedRedditUrl {
  readonly url: string;
  title: string;
  snippet: string;
  date?: string;
  frequency: number;
  readonly positions: number[];
  readonly queries: string[];
  bestPosition: number;
  totalScore: number;
}

/**
 * Ranked Reddit URL with normalized score
 */
interface RankedRedditUrl {
  readonly url: string;
  readonly title: string;
  readonly snippet: string;
  readonly date?: string;
  readonly rank: number;
  readonly score: number;
  readonly frequency: number;
  readonly positions: number[];
  readonly queries: string[];
  readonly bestPosition: number;
  readonly isConsensus: boolean;
}

/**
 * Reddit aggregation result
 */
interface RedditAggregationResult {
  readonly rankedUrls: RankedRedditUrl[];
  readonly totalUniqueUrls: number;
  readonly totalQueries: number;
  readonly frequencyThreshold: number;
  readonly thresholdNote?: string;
}

/**
 * Aggregate Reddit search results from multiple queries
 */
function aggregateRedditResults(
  searches: Map<string, RedditSearchResult[]>
): Map<string, AggregatedRedditUrl> {
  const urlMap = new Map<string, AggregatedRedditUrl>();

  for (const [query, results] of searches) {
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (!result) continue;
      const position = i + 1;
      const normalizedUrl = normalizeUrl(result.url);
      const existing = urlMap.get(normalizedUrl);

      if (existing) {
        existing.frequency += 1;
        existing.positions.push(position);
        existing.queries.push(query);
        const prevBest = existing.bestPosition;
        existing.bestPosition = Math.min(existing.bestPosition, position);
        existing.totalScore += getCtrWeight(position);
        // Keep best title/snippet (from highest ranking position)
        if (position < prevBest) {
          existing.title = result.title;
          existing.snippet = result.snippet;
          existing.date = result.date;
        }
      } else {
        urlMap.set(normalizedUrl, {
          url: result.url,
          title: result.title,
          snippet: result.snippet,
          date: result.date,
          frequency: 1,
          positions: [position],
          queries: [query],
          bestPosition: position,
          totalScore: getCtrWeight(position),
        });
      }
    }
  }

  return urlMap;
}

/**
 * Count Reddit URLs meeting a frequency threshold
 */
function countRedditByFrequency(
  urlMap: Map<string, AggregatedRedditUrl>,
  minFrequency: number
): number {
  let count = 0;
  for (const url of urlMap.values()) {
    if (url.frequency >= minFrequency) count++;
  }
  return count;
}

/**
 * Calculate weighted scores for Reddit URLs
 * Returns ALL URLs sorted by score with consensus marking
 */
function calculateRedditWeightedScores(urls: AggregatedRedditUrl[], consensusThreshold: number): RankedRedditUrl[] {
  if (urls.length === 0) return [];

  // Sort by total score descending
  const sorted = [...urls].sort((a, b) => b.totalScore - a.totalScore);

  // Find max score for normalization
  const maxScore = sorted[0]!.totalScore;

  // Map to ranked URLs with normalized scores
  return sorted.map((url, index) => ({
    url: url.url,
    title: url.title,
    snippet: url.snippet,
    date: url.date,
    rank: index + 1,
    score: maxScore > 0 ? (url.totalScore / maxScore) * 100 : 0,
    frequency: url.frequency,
    positions: url.positions,
    queries: url.queries,
    bestPosition: url.bestPosition,
    isConsensus: url.frequency >= consensusThreshold,
  }));
}

/**
 * Full Reddit aggregation pipeline — returns ALL URLs ranked by CTR score.
 * Determines a consensus threshold for labeling, never drops URLs.
 */
export function aggregateAndRankReddit(
  searches: Map<string, RedditSearchResult[]>,
  minConsensusUrls: number = DEFAULT_REDDIT_MIN_CONSENSUS_URLS
): RedditAggregationResult {
  const urlMap = aggregateRedditResults(searches);
  const totalUniqueUrls = urlMap.size;
  const totalQueries = searches.size;

  // Determine consensus threshold for labeling (not filtering)
  const thresholds = [2, 1];
  let usedThreshold = 1;
  let thresholdNote: string | undefined;

  for (const threshold of thresholds) {
    const count = countRedditByFrequency(urlMap, threshold);
    if (count >= minConsensusUrls || threshold === 1) {
      usedThreshold = threshold;
      if (threshold < 2 && totalQueries > 1) {
        thresholdNote = `Note: Consensus threshold set to ≥${threshold} due to result diversity across queries.`;
      }
      break;
    }
  }

  // Rank ALL URLs, marking consensus based on determined threshold
  const allUrls = [...urlMap.values()];
  const rankedUrls = calculateRedditWeightedScores(allUrls, usedThreshold);

  return {
    rankedUrls,
    totalUniqueUrls,
    totalQueries,
    frequencyThreshold: usedThreshold,
    thresholdNote,
  };
}

/**
 * Generate enhanced output for Reddit aggregated results
 * Now includes both aggregated view AND per-query raw results
 */
export function generateRedditEnhancedOutput(
  aggregation: RedditAggregationResult,
  allQueries: string[],
  rawResults?: Map<string, RedditSearchResult[]>
): string {
  const { rankedUrls, totalUniqueUrls, frequencyThreshold, thresholdNote } = aggregation;
  const lines: string[] = [];

  // Header
  lines.push(`# 🔍 Reddit Search Results (Aggregated from ${allQueries.length} Queries)`);
  lines.push('');
  lines.push(`**Total Unique Posts:** ${totalUniqueUrls} | **Consensus Threshold:** ≥${frequencyThreshold} appearances`);
  lines.push('');

  if (thresholdNote) {
    lines.push(`> ${thresholdNote}`);
    lines.push('');
  }

  // Consensus section (URLs appearing in multiple queries)
  const consensusUrls = rankedUrls.filter(u => u.frequency >= frequencyThreshold && u.frequency > 1);
  if (consensusUrls.length > 0) {
    lines.push('## ⭐ High-Consensus Posts (Multiple Queries)');
    lines.push('');
    lines.push('*These posts appeared across multiple search queries, indicating high relevance:*');
    lines.push('');

    for (const url of consensusUrls) {
      const dateStr = url.date ? ` • 📅 ${url.date}` : '';
      const queriesList = url.queries.map(q => `"${q}"`).join(', ');
      lines.push(`### #${url.rank}: ${url.title}`);
      lines.push(`**Score:** ${url.score.toFixed(1)} | **Found in:** ${url.frequency} queries (${queriesList})${dateStr}`);
      lines.push(`${url.url}`);
      lines.push(`> ${url.snippet}`);
      lines.push('');
    }

    lines.push('---');
    lines.push('');
  }

  // All results ranked by CTR score
  lines.push('## 📊 All Results (CTR-Ranked)');
  lines.push('');

  for (const url of rankedUrls) {
    const dateStr = url.date ? ` • 📅 ${url.date}` : '';
    const consensusMarker = url.frequency > 1 ? ' ⭐' : '';
    lines.push(`**${url.rank}. ${url.title}**${consensusMarker}${dateStr}`);
    lines.push(`${url.url}`);
    lines.push(`> ${url.snippet}`);
    if (url.frequency > 1) {
      lines.push(`_Found in ${url.frequency} queries: ${url.queries.map(q => `"${q}"`).join(', ')}_`);
    }
    lines.push('');
  }

  // Per-Query Raw Results Section (NEW)
  if (rawResults && rawResults.size > 0) {
    lines.push('---');
    lines.push('');
    lines.push('## 📋 Per-Query Raw Results');
    lines.push('');
    lines.push('*Complete results for each individual query before aggregation:*');
    lines.push('');

    for (const [query, results] of rawResults) {
      lines.push(`### 🔎 Query: "${query}"`);
      lines.push(`**Results:** ${results.length} posts`);
      lines.push('');

      if (results.length === 0) {
        lines.push('_No results found for this query._');
        lines.push('');
        continue;
      }

      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (!result) continue;
        const position = i + 1;
        const dateStr = result.date ? ` • 📅 ${result.date}` : '';
        lines.push(`${position}. **${result.title}**${dateStr}`);
        lines.push(`   ${result.url}`);
        lines.push(`   > ${result.snippet}`);
        lines.push('');
      }
    }
  }

  // Metadata
  lines.push('---');
  lines.push('');
  lines.push('### 📈 Search Metadata');
  lines.push('');
  lines.push(`- **Queries:** ${allQueries.map(q => `"${q}"`).join(', ')}`);
  lines.push(`- **Unique Posts Found:** ${totalUniqueUrls}`);
  lines.push(`- **High-Consensus Posts:** ${consensusUrls.length}`);
  lines.push('');

  return lines.join('\n');
}
