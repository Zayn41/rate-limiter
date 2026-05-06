/**
 * State representation for the Token Bucket algorithm.
 * 
 * @property tokens - Current number of available tokens
 * @property lastRefill - Timestamp (in ms) of the last refill operation
 */
export interface TokenBucketState {
    tokens: number;
    lastRefill: number;
}

/**
 * State representation for the Fixed Window algorithm.
 * 
 * @property count - Number of requests made in the current window
 * @property windowStart - Timestamp (in ms) marking the start of the window
 */
export interface FixedWindowState {
    count: number;
    windowStart: number;
}

export interface SlidingWindowState {
    currentCount: number;
    previousCount: number;
    windowStart: number;
}

/**
 * State representation for the Sliding Window algorithm.
 * 
 * @property timestamps - Array of request timestamps (in ms)
 * @property windowStart - Timestamp (in ms) of the current window boundary
 */
export interface SlidingWindowLogState {   
    timestamps: number[];
}

/**
 * Unified state type for all supported rate limiting algorithms.
 * 
 * Each variant contains:
 * - `type`: Identifies the algorithm
 * - `data`: Algorithm-specific state
 * - `ttl`: Optional time-to-live in milliseconds (used by store for expiration)
 * 
 * @remarks
 * - `ttl` is managed by the algorithm layer and passed to the store.
 * - The store should treat TTL as an expiration hint, not modify it.
 * 
 * @example
 * ```ts
 * const state: RateLimitState = {
 *   type: "token",
 *   data: { tokens: 10, lastRefill: Date.now() },
 *   ttl: 60_000
 * };
 * ```
 */
export type RateLimitState = 
    | { type: "token"; data: TokenBucketState; ttl: number }
    | { type: "fixed"; data: FixedWindowState; ttl: number }
    | { type: "sliding-count"; data: SlidingWindowState; ttl: number }
    | { type: "sliding-log"; data: SlidingWindowLogState; ttl: number };
