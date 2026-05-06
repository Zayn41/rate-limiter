import type { RateLimitResult } from "../types/result";
import type { RateLimitAlgorithm } from "../types/algorithm";
import type { AlgorithmConfig } from "../types/algorithm";
import type { RateLimitState } from "../types/state";

/**
 * Fixed Window Counter algorithm implementation.
 * 
 * Divides time into fixed windows and counts requests within each window.
 * When a new window starts, the counter resets.
 * 
 * Pros:
 * - Simple to understand and implement
 * - Low memory footprint
 * 
 * Cons:
 * - Allows burst at window boundaries ("hammer at midnight" problem)
 * 
 * @example
 * ```ts
 * const algorithm = new FixedWindowAlgorithm();
 * const result = algorithm.process(null, {
 *   limit: 100,
 *   windowMs: 60_000,
 *   weight: 1
 * });
 * ```
 */
export class FixedWindowAlgorithm implements RateLimitAlgorithm {
    public readonly name = "fixed-window";

    /**
     * Processes a request using the fixed window algorithm.
     * 
     * @param state - Current state for this key (null if first request)
     * @param config - Algorithm configuration
     * @returns Updated state and rate limit decision
     */
    public process(
        state: RateLimitState | null, 
        config: AlgorithmConfig
    ): { newState: RateLimitState; result: RateLimitResult } {
        // Get current time
        const now = Date.now();
        const weight = Math.max(1, config.weight ?? 1);
        // Get current window start time
        const currentWindowStart = this.calculateWindowStart(now, config.windowMs);
        const windowEnd = currentWindowStart + config.windowMs;
        const ttl = Math.max(1, windowEnd - now);

        // Check if this is a new window or new state
        const isNewWindow = !state || 
            state.type !== "fixed" || 
            state.data.windowStart !== currentWindowStart ||
            state.data.windowStart > now; // clock skew guard

        if(isNewWindow) {
            // New window or first request
            const allowed = weight <= config.limit;
            const count = allowed ? weight : 0; // don't count denied requests
            const newState = this.buildState(count, currentWindowStart, ttl);
            return { newState, result: this.buildResult(config, count, windowEnd, now, allowed) };
        }

        // Same window
        const currCount = state.data.count;
        const allowed = currCount + weight <= config.limit;
        const newCount = allowed ? currCount + weight : currCount;

        const newState = this.buildState(newCount, currentWindowStart, ttl);

        return {
           newState,
            result: this.buildResult(
                config,
                newCount,
                windowEnd,
                now,
                allowed
            )
        };
    }

    /**
     * Calculates the start timestamp of the current window.
     * 
     * @private
     * @param now - Current timestamp in milliseconds
     * @param windowMs - Window duration in milliseconds
     * @returns Timestamp of current window start
     */
    private calculateWindowStart(now: number, windowMs: number): number {
        return Math.floor(now / windowMs) * windowMs;
    }

    /**
     * Initializes fresh state for a new window.
     * 
     * @private
     * @param config - Algorithm configuration
     * @param windowStart - Start timestamp of the window
     * @param now - Current timestamp
     * @param allowed - Whether the initial request is allowed
     * @returns Fresh RateLimitState for the window
     */
    private buildState(
        count: number,
        windowStart: number, 
        ttl: number
    ): RateLimitState {
        return {
            type: "fixed",
            data: {
                count: count,
                windowStart
            },
            ttl
        };
    }

    /**
     * Builds the result object for a rate limit check.
     * 
     * @private
     * @param config - Algorithm configuration
     * @param count - Current request count in window
     * @param windowStart - Start timestamp of current window
     * @param now - Current timestamp
     * @param allowed - Whether request is allowed
     * @returns RateLimitResult with decision and metadata
     */
    private buildResult(
        config: AlgorithmConfig, 
        count: number, 
        windowEnd: number, 
        now: number, 
        allowed: boolean
    ): RateLimitResult {
        const remaining = Math.max(0, config.limit - count);
        const msUntilReset = Math.max(0, windowEnd - now);

        return {
            allowed,
            remaining,
            limit: config.limit,
            resetTime: windowEnd,
            ...(allowed ? {} : { retryAfter: Math.ceil(msUntilReset / 1000) })
        };
    }
}