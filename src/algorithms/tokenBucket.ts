import type { RateLimitResult } from "../types/result";
import type { RateLimitAlgorithm } from "../types/algorithm";
import type { AlgorithmConfig } from "../types/algorithm";
import type { RateLimitState } from "../types/state";

/**
 * Token Bucket algorithm implementation.
 * 
 * Tokens accumulate at a fixed rate. Each request consumes tokens.
 * Allows smooth request handling with burst capacity.
 * 
 * Pros:
 * - Allows burst traffic (up to limit)
 * - Smooth token refill
 * - No "hammer at midnight" problem
 * 
 * Cons:
 * - Slightly more complex than fixed window
 * - Requires tracking last refill time
 * 
 * @example
 * ```ts
 * const algorithm = new TokenBucketAlgorithm();
 * const result = algorithm.process(null, {
 *   limit: 100,
 *   windowMs: 60_000,
 *   weight: 1
 * });
 * ```
 */
export class TokenBucketAlgorithm implements RateLimitAlgorithm {
    public readonly name = "token-bucket";

    /**
     * Processes a request using the token bucket algorithm.
     * 
     * Refills tokens based on elapsed time, then deducts tokens
     * for the incoming request if sufficient tokens are available.
     * 
     * Algorithm flow:
     * 1. Calculate token refill based on time elapsed
     * 2. Cap tokens at configured limit
     * 3. Check if enough tokens for this request
     * 4. Deduct tokens if allowed
     * 5. Return new state and decision result
     * 
     * @param state - Current state for this key (null for first request)
     * @param config - Algorithm configuration (limit, windowMs, weight)
     * @returns Object with:
     *   - `newState`: Updated state for storage backend
     *   - `result`: Rate limit decision and metadata
     * 
     * @throws {Error} If weight is not positive
     * 
     * @example
     * ```ts
     * // First request
     * const result1 = algorithm.process(null, { limit: 100, windowMs: 60000, weight: 1 });
     * 
     * // Subsequent request with saved state
     * const result2 = algorithm.process(result1.newState, { limit: 100, windowMs: 60000, weight: 1 });
     * ```
     */
    public process(
        state: RateLimitState | null, 
        config: AlgorithmConfig
    ): { newState: RateLimitState; result: RateLimitResult; } {
        // get current time
        const now = Date.now();
        const PRECISION = 1_000_000; 
        // Calculate refill once
        const refillRate = config.limit / config.windowMs;

        // Initialize state if first request
        if(!state || state.type !== "token") {
            const allowed = config.weight <= config.limit;
            const initialTokens = allowed 
                ? Math.floor((config.limit - config.weight) * PRECISION) / PRECISION 
                : config.limit;
            const newState = this.buildState(initialTokens, now, config);
            return { newState, result: this.buildResult(config, initialTokens, allowed, now, refillRate) };
        }

        // Extract state 
        const tokenState = state.data;
        const delta = Math.max(0, now - tokenState.lastRefill);

        const tokensToAdd = Math.round(delta * refillRate * PRECISION) / PRECISION;
        const refilled = Math.min(
            config.limit, 
            Math.round((tokenState.tokens + tokensToAdd) * PRECISION) / PRECISION
        );

        // Allow new request if allowed
        const allowed = refilled >= config.weight;
        const finalTokens = allowed 
            ? Math.round((refilled - config.weight) * PRECISION) / PRECISION 
            : refilled;
        const didRefill = tokensToAdd > 0;

        const newState = this.buildState(
            finalTokens,
            didRefill ? now : tokenState.lastRefill, // don't advance clock if no refill
            config
        );

        return { newState, result: this.buildResult(config, finalTokens, allowed, now, refillRate) };
    }

    /**
     * Calculates Time-To-Live for token bucket state.
     * 
     * Determines how long until the bucket is completely refilled.
     * Used by storage backend for automatic expiration.
     * 
     * @private
     * @param config - Algorithm configuration
     * @param finalTokens - Current token count after request processing
     * @returns TTL in milliseconds (minimum 1ms)
     * 
     * @remarks
     * - If bucket is full or overfull, returns windowMs
     * - TTL calculation: missingTokens / refillRate
     * - Always returns at least 1ms to prevent zero-TTL issues
     * 
     * @example
     * ```ts
     * // Bucket with 3/10 tokens, 60s window
     * const ttl = this.calculateTTL(config, 3);  // ~42 seconds
     * ```
     */
    private calculateTTL(config: AlgorithmConfig, finalTokens: number): number {
        const missingTokens = config.limit - finalTokens;

        // already full
        if(missingTokens <= 0) {
            return config.windowMs;
        }

        const timeToFull = missingTokens * (config.windowMs / config.limit);
        const ttl = Math.max(1, Math.ceil(timeToFull));
        return ttl;
    }

    /**
     * Constructs a new Token Bucket state object.
     * 
     * This method encapsulates the creation of the internal state
     * used by the token bucket algorithm, including:
     * - Current token count
     * - Last refill timestamp
     * - Computed TTL (time until bucket is fully refilled)
     * 
     * The TTL is derived based on how long it will take for the
     * bucket to return to full capacity, and is used by the store
     * for automatic expiration.
     * 
     * @private
     * @param tokens - Current number of tokens remaining in the bucket
     * @param lastRefill - Timestamp (in milliseconds) of the last refill operation
     * @param config - Algorithm configuration (limit and windowMs)
     * 
     * @returns A fully constructed RateLimitState object for token bucket
     * 
     * @example
     * ```ts
     * const state = this.buildState(5, Date.now(), {
     *   limit: 10,
     *   windowMs: 10000,
     *   weight: 1
     * });
     * ```
     */
    private buildState(tokens: number, lastRefill: number, config: AlgorithmConfig): RateLimitState {
        return {
            type: "token",
            data: { tokens, lastRefill },
            ttl: this.calculateTTL(config, tokens)
        };
    }

    /**
     * Constructs the rate limit result for the client.
     * 
     * Contains decision (allowed/denied), remaining tokens,
     * reset time, and retry guidance if rate limited.
     * 
     * @private
     * @param config - Algorithm configuration
     * @param tokens - Current tokens remaining in bucket
     * @param allowed - Whether the request can proceed
     * @param now - Current timestamp in milliseconds
     * @param refillRate - Tokens added per millisecond
     * 
     * @returns RateLimitResult with HTTP-friendly metadata
     * 
     * @remarks
     * - `remaining`: Floored to integer for client compatibility
     * - `resetTime`: When bucket will be completely full
     * - `retryAfter`: Only included if request was denied
     * - All times are absolute timestamps (milliseconds)
     */
    private buildResult(
        config: AlgorithmConfig, 
        tokens: number, 
        allowed: boolean, 
        now: number, 
        refillRate: number
    ): RateLimitResult {
        const tokensToFull = config.limit - tokens;
        const timeToFullMs = tokensToFull / refillRate;

        const tokenNeeded = Math.max(0, config.weight - tokens);
        const timeUntilAllowedMs = tokenNeeded / refillRate;

        return {
            allowed,
            remaining: Math.max(0, Math.floor(tokens)),
            limit: config.limit,
            resetTime: now + Math.ceil(timeToFullMs),
            ...(allowed ? {} : { retryAfter: Math.ceil(timeUntilAllowedMs / 1000) })
        };
    }
}