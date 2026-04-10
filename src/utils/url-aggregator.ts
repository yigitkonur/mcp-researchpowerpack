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

/** Maximum number of alternative snippets to retain per URL */
const MAX_ALT_SNIPPETS = 3 as const;

/** Consistency penalty cap — bounds the impact of position variance */
const MAX_CONSISTENCY_PENALTY = 0.15 as const;

/** Standard deviation normalizer — stdDev of 5+ gets full penalty */
const CONSISTENCY_STDDEV_SCALE = 5 as const;

/**
 * Aggregated URL data structure
 */
interface AggregatedUrl {
  readonly url: string;
  title: string;
  snippet: string;
  readonly allSnippets: string[];
  frequency: number;
  readonly positions: number[];
  readonly queries: string[];
  bestPosition: number;
  totalScore: number;
}

/**
 * Compute position statistics for consistency scoring
 */
function computePositionStats(positions: number[]): { mean: number; stdDev: number; consistencyMultiplier: number } {
  if (positions.length <= 1) {
    return { mean: positions[0] ?? 0, stdDev: 0, consistencyMultiplier: 1.0 };
  }
  const mean = positions.reduce((a, b) => a + b, 0) / positions.length;
  const variance = positions.reduce((sum, p) => sum + (p - mean) ** 2, 0) / (positions.length - 1);
  const stdDev = Math.sqrt(variance);
  const consistencyMultiplier = 1.0 - MAX_CONSISTENCY_PENALTY * Math.min(stdDev / CONSISTENCY_STDDEV_SCALE, 1.0);
  return { mean, stdDev, consistencyMultiplier };
}

/**
 * Ranked URL with normalized score and enriched signals
 */
interface RankedUrl {
  readonly url: string;
  readonly title: string;
  readonly snippet: string;
  readonly allSnippets: string[];
  readonly rank: number;
  readonly score: number;
  readonly frequency: number;
  readonly positions: number[];
  readonly queries: string[];
  readonly bestPosition: number;
  readonly isConsensus: boolean;
  readonly coverageRatio: number;
  readonly positionStdDev: number;
  readonly consistencyMultiplier: number;
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
        // Collect distinct snippets (up to MAX_ALT_SNIPPETS)
        if (
          result.snippet &&
          existing.allSnippets.length < MAX_ALT_SNIPPETS &&
          !existing.allSnippets.some(s => s === result.snippet)
        ) {
          existing.allSnippets.push(result.snippet);
        }
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
          allSnippets: result.snippet ? [result.snippet] : [],
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
 * Calculate weighted scores with consistency multiplier, normalize to 100.0.
 * Returns ALL URLs sorted by composite score with rank assignments and consensus marking.
 */
function calculateWeightedScores(urls: AggregatedUrl[], consensusThreshold: number, totalQueries: number): RankedUrl[] {
  if (urls.length === 0) return [];

  // Compute composite scores (base CTR × consistency multiplier)
  const scored = urls.map(url => {
    const stats = computePositionStats(url.positions);
    const compositeScore = url.totalScore * stats.consistencyMultiplier;
    return { url, compositeScore, stats };
  });

  // Sort by composite score descending
  scored.sort((a, b) => b.compositeScore - a.compositeScore);

  // Find max for normalization
  const maxScore = scored[0]!.compositeScore;

  // Map to ranked URLs with all signals
  return scored.map(({ url, compositeScore, stats }, index) => ({
    url: url.url,
    title: url.title,
    snippet: url.snippet,
    allSnippets: url.allSnippets,
    rank: index + 1,
    score: maxScore > 0 ? (compositeScore / maxScore) * 100 : 0,
    frequency: url.frequency,
    positions: url.positions,
    queries: url.queries,
    bestPosition: url.bestPosition,
    isConsensus: url.frequency >= consensusThreshold,
    coverageRatio: totalQueries > 0 ? url.frequency / totalQueries : 0,
    positionStdDev: stats.stdDev,
    consistencyMultiplier: stats.consistencyMultiplier,
  }));
}

/**
 * Mark consensus status for a URL against a given threshold.
 * Returns "CONSENSUS" if frequency >= threshold, else empty string.
 */
export function markConsensus(frequency: number, threshold: number = WEB_CONSENSUS_THRESHOLD): string {
  return frequency >= threshold ? 'CONSENSUS' : '';
}

/** Maximum keywords to show in the coverage table before collapsing */
const COVERAGE_TABLE_MAX_ROWS = 20 as const;

/**
 * Consistency label based on position standard deviation
 */
function consistencyLabel(stdDev: number, frequency: number): string {
  if (frequency <= 1) return 'n/a';
  if (stdDev < 1.5) return 'high';
  if (stdDev < 3.5) return 'medium';
  return 'variable';
}

/**
 * Generate a unified output where every URL appears exactly once.
 * Replaces the old generateEnhancedOutput + per-query section combo.
 */
export function generateUnifiedOutput(
  rankedUrls: RankedUrl[],
  allKeywords: string[],
  keywordResults: KeywordSearchResult[],
  totalUniqueUrls: number,
  frequencyThreshold: number,
  thresholdNote?: string,
): string {
  const lines: string[] = [];
  const consensusCount = rankedUrls.filter(u => u.isConsensus).length;

  // Header
  lines.push(`## Web Search Results (${allKeywords.length} queries, ${totalUniqueUrls} unique URLs)`);
  lines.push('');
  if (thresholdNote) {
    lines.push(`> ${thresholdNote}`);
    lines.push('');
  }

  // Ranked URL list — every URL exactly once
  for (const url of rankedUrls) {
    const consensusTag = url.frequency >= HIGH_CONSENSUS_THRESHOLD
      ? ' CONSENSUS+++'
      : url.isConsensus
        ? ' CONSENSUS'
        : '';
    const coveragePct = Math.round(url.coverageRatio * 100);
    const consistency = consistencyLabel(url.positionStdDev, url.frequency);

    lines.push(`**${url.rank}. [${url.title}](${url.url})**${consensusTag}`);
    lines.push(`Score: ${url.score.toFixed(1)} | Seen in: ${url.frequency}/${allKeywords.length} queries (${coveragePct}%) | Best pos: #${url.bestPosition} | Consistency: ${consistency}`);
    lines.push(`Queries: ${url.queries.map(q => `"${q}"`).join(', ')}`);
    lines.push(`> ${url.snippet}`);

    // Alt snippets (if multiple distinct snippets were collected)
    if (url.allSnippets.length > 1) {
      const alts = url.allSnippets
        .filter(s => s !== url.snippet)
        .slice(0, 3)
        .map(s => s.length > 100 ? s.slice(0, 97) + '...' : s);
      if (alts.length > 0) {
        lines.push(`Alt: ${alts.map(s => `"${s}"`).join(' | ')}`);
      }
    }

    lines.push('');
  }

  // Keyword coverage section
  lines.push('---');

  if (allKeywords.length <= COVERAGE_TABLE_MAX_ROWS) {
    // Full table for ≤20 keywords
    lines.push('### Keyword Coverage');
    lines.push('| Keyword | Results | Top URL | Top Pos |');
    lines.push('|---------|---------|---------|---------|');

    for (const search of keywordResults) {
      const topResult = search.results[0];
      let topDomain = '';
      if (topResult) {
        try {
          topDomain = new URL(topResult.link).hostname.replace(/^www\./, '');
        } catch {
          topDomain = topResult.link;
        }
      }
      lines.push(`| "${search.keyword}" | ${search.results.length} | ${topDomain || '—'} | ${topResult ? `#${topResult.position}` : '—'} |`);
    }
    lines.push('');
  } else {
    // Collapsed summary for >20 keywords
    const goodCount = keywordResults.filter(s => s.results.length >= 3).length;
    lines.push(`### Keyword Coverage: ${goodCount}/${allKeywords.length} keywords returned 3+ results`);
    lines.push('');
  }

  // Low-yield keywords
  const lowYield = keywordResults.filter(s => s.results.length <= 1);
  if (lowYield.length > 0) {
    lines.push(`**Low-yield keywords** (0-1 results): ${lowYield.map(s => `\`${s.keyword}\``).join(', ')}`);
    lines.push('');
  }

  // Related searches (merged and deduplicated)
  const allRelated = new Set<string>();
  for (const search of keywordResults) {
    if (search.related) {
      for (const r of search.related) {
        allRelated.add(r);
      }
    }
  }
  if (allRelated.size > 0) {
    const related = [...allRelated].slice(0, 10);
    lines.push(`**Related searches:** ${related.map(r => `\`${r}\``).join(', ')}`);
    lines.push('');
  }

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
  const rankedUrls = calculateWeightedScores(allUrls, usedThreshold, totalQueries);

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
