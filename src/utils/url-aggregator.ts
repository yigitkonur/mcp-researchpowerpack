/**
 * URL Aggregator Utility
 * Aggregates search results across multiple queries, calculates CTR-weighted scores,
 * and generates consensus-based rankings.
 */

import { CTR_WEIGHTS } from '../config/index.js';
import type { QuerySearchResult } from '../clients/search.js';

/** Minimum frequency for web search consensus marking */
const WEB_CONSENSUS_THRESHOLD = 3 as const;


/** Minimum weight assigned to positions beyond top 10 */
const MIN_BEYOND_TOP10_WEIGHT = 0 as const;

/** Weight decay per position beyond top 10 */
const BEYOND_TOP10_DECAY = 0.5 as const;

/** Base position for beyond-top-10 weight calculation */
const BEYOND_TOP10_BASE = 10 as const;

/** Default minimum consensus URLs before lowering threshold (web search) */
const DEFAULT_MIN_CONSENSUS_URLS = 5 as const;

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
function aggregateResults(searches: QuerySearchResult[]): Map<string, AggregatedUrl> {
  const urlMap = new Map<string, AggregatedUrl>();

  for (const search of searches) {
    for (const result of search.results) {
      const normalizedUrl = normalizeUrl(result.link);
      const existing = urlMap.get(normalizedUrl);

      if (existing) {
        existing.frequency += 1;
        existing.positions.push(result.position);
        existing.queries.push(search.query);
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
          queries: [search.query],
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

/** Maximum queries to show in the coverage table before collapsing */
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
  allQueries: string[],
  queryResults: QuerySearchResult[],
  totalUniqueUrls: number,
  frequencyThreshold: number,
  thresholdNote?: string,
): string {
  const lines: string[] = [];
  const consensusCount = rankedUrls.filter(u => u.isConsensus).length;

  // Header
  lines.push(`## Web Search Results (${allQueries.length} queries, ${totalUniqueUrls} unique URLs)`);
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
    lines.push(`Score: ${url.score.toFixed(1)} | Seen in: ${url.frequency}/${allQueries.length} queries (${coveragePct}%) | Best pos: #${url.bestPosition} | Consistency: ${consistency}`);
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

  if (allQueries.length <= COVERAGE_TABLE_MAX_ROWS) {
    // Full table for ≤20 queries
    lines.push('### Query Coverage');
    lines.push('| Query | Results | Top URL | Top Pos |');
    lines.push('|---------|---------|---------|---------|');

    for (const search of queryResults) {
      const topResult = search.results[0];
      let topDomain = '';
      if (topResult) {
        try {
          topDomain = new URL(topResult.link).hostname.replace(/^www\./, '');
        } catch {
          topDomain = topResult.link;
        }
      }
      lines.push(`| "${search.query}" | ${search.results.length} | ${topDomain || '—'} | ${topResult ? `#${topResult.position}` : '—'} |`);
    }
    lines.push('');
  } else {
    // Collapsed summary for >20 queries
    const goodCount = queryResults.filter(s => s.results.length >= 3).length;
    lines.push(`### Query Coverage: ${goodCount}/${allQueries.length} queries returned 3+ results`);
    lines.push('');
  }

  // Low-yield queries
  const lowYield = queryResults.filter(s => s.results.length <= 1);
  if (lowYield.length > 0) {
    lines.push(`**Low-yield queries** (0-1 results): ${lowYield.map(s => `\`${s.query}\``).join(', ')}`);
    lines.push('');
  }

  // Related searches (merged and deduplicated)
  const allRelated = new Set<string>();
  for (const search of queryResults) {
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
  searches: QuerySearchResult[],
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

