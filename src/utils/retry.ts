/**
 * Shared retry and backoff utilities
 */

/** Jitter factor to prevent thundering herd */
const JITTER_FACTOR = 0.3 as const;

/** Exponential base for backoff calculation */
const EXPONENTIAL_BASE = 2 as const;

/** Default base delay for exponential backoff (ms) */
const DEFAULT_BASE_DELAY_MS = 1_000 as const;

/** Default maximum backoff delay cap (ms) */
const DEFAULT_MAX_DELAY_MS = 30_000 as const;

/**
 * Calculate exponential backoff delay with jitter.
 * Formula: min(base * 2^attempt + random_jitter, maxDelay)
 *
 * @param attempt - Zero-based retry attempt number
 * @param baseDelayMs - Base delay in milliseconds (default: 1000)
 * @param maxDelayMs - Maximum delay cap in milliseconds (default: 30000)
 * @returns Delay in milliseconds with jitter applied
 */
export function calculateBackoff(
  attempt: number,
  baseDelayMs: number = DEFAULT_BASE_DELAY_MS,
  maxDelayMs: number = DEFAULT_MAX_DELAY_MS,
): number {
  const exponentialDelay = baseDelayMs * Math.pow(EXPONENTIAL_BASE, attempt);
  const jitter = JITTER_FACTOR * exponentialDelay * Math.random();
  return Math.min(exponentialDelay + jitter, maxDelayMs);
}
