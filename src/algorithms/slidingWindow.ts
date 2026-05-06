import type { AlgorithmConfig, RateLimitAlgorithm } from "../types/algorithm";
import type { RateLimitResult } from "../types/result";
import type { RateLimitState } from "../types/state";

/**
 * Sliding Window Log algorithm implementation.
 * 
 * Maintains exact timestamps of each request within the window.
 * Provides the most accurate rate limiting with no "hammer at midnight" problem.
 * 
 * Algorithm:
 * 1. Remove timestamps older than current window
 * 2. Count remaining timestamps
 * 3. If count + weight <= limit, allow and add weight timestamps
 * 4. Otherwise, deny and calculate when oldest expires
 * 
 * Pros:
 * - Most accurate rate limiting (exact timestamps)
 * - No burst at window boundaries
 * - Precise retry-after calculation
 * 
 * Cons:
 * - O(n) space for storing timestamps
 * - O(k) cleanup where k = expired requests
 * 
 * @example
 * ```ts
 * const algo = new SlidingWindowLogAlgorithm();
 * const result = algo.process(null, {
 *   limit: 100,
 *   windowMs: 60_000,
 *   weight: 1
 * });
 * ```
 */
export class SlidingWindowLogAlgorithm implements RateLimitAlgorithm {
    public readonly name = "sliding-window-log";

    /**
     * Processes a request using sliding window log algorithm.
     * 
     * Steps:
     * 1. Calculate window start time (now - windowMs)
     * 2. Prune expired timestamps from the front (O(k) where k = expired)
     * 3. Check if current + weight <= limit
     * 4. If allowed: add weight timestamps, return decision
     * 5. If denied: calculate retry-after based on oldest expiring timestamp
     * 
     * @param state - Current state with existing timestamps (null for first request)
     * @param config - Algorithm config (limit, windowMs, weight)
     * @returns Updated state and rate limit decision
     * 
     * Time Complexity: O(k) where k = number of expired timestamps (often O(1))
     * Space Complexity: O(n) where n = number of requests in window
     */
    public process(
        state: RateLimitState | null, 
        config: AlgorithmConfig
    ): { newState: RateLimitState; result: RateLimitResult; } {
        const now = Date.now(); // get current time
        const windowStart = now - config.windowMs; // get current window 

        // Get existing timestamps or empty array
        const raw = state?.type === "sliding-log" ? state.data.timestamps : [];
        const n = raw.length;

        // Deque-style prune: pop from front while expired
        // O(k) where k = expired count, often O(1)
        let startIndex = 0;
        while(startIndex < n && raw[startIndex]! < windowStart) {
            startIndex++;
        }

        // Slice once instead of shifting N times — O(1) slice, no mutation
        const timestamps = startIndex > 0 ? raw.slice(startIndex) : [...raw];

        // Check capacity BEFORE adding new timestamps
        const currentCount = timestamps.length;
        const allowed = currentCount + config.weight <= config.limit;
        
        // Check allowed if allowed push timestamps
        if(allowed) {
            // Push one slot per weight unit — loop is bounded by weight <= limit
            for(let i = 0; i < config.weight; i++) {
                timestamps.push(now);
            }
        }

        return {
            newState: this.buildState(timestamps, now, config),
            result: this.buildResult(allowed, timestamps, currentCount, now, config)
        };
    }

    /**
     * Builds the new state object with pruned timestamps.
     * 
     * TTL is calculated from the NEWEST timestamp to ensure the entire
     * state expires only when all requests have left the window.
     * 
     * @private
     * @param timestamps - Sorted array of valid timestamps in current window
     * @param config - Algorithm configuration
     * @returns RateLimitState ready for storage
     * 
     * @remarks
     * - TTL must use newest timestamp, not oldest
     * - Ensures state cleanup aligns with actual window expiration
     */
    private buildState(timestamps: number[], now: number, config: AlgorithmConfig): RateLimitState {
        // TTL = time until NEWEST timestamp falls outside window
        // Must use newest — oldest would expire the entry too early
        const ttl = timestamps.length > 0 
            ? Math.max(1, (timestamps[timestamps.length - 1]! + config.windowMs) - now)
            : config.windowMs;

        return {
            type: "sliding-log",
            data: {
                timestamps: timestamps
            },
            ttl: ttl
        };
    }

    /**
     * Builds the rate limit result object.
     * 
     * Key insight: retryAfter is calculated by finding when the oldest
     * request that's preventing this one expires. This gives precise
     * "come back in X seconds" timing.
     * 
     * @private
     * @param allowed - Whether request is allowed
     * @param timestamps - All timestamps currently in window (after adding if allowed)
     * @param countBeforeRequest - Number of timestamps BEFORE this request
     * @param now - Current timestamp
     * @param config - Algorithm configuration
     * @returns RateLimitResult with precise retry timing
     * 
     * @remarks
     * - If denied: retryAfter = when oldest conflicting request expires
     * - remaining = limit - current timestamp count
     * - resetTime = when oldest request leaves window
     */
    private buildResult(
        allowed: boolean, 
        timestamps: number[], 
        countBeforeRequest: number,
        now: number,
        config: AlgorithmConfig
        ): RateLimitResult {
        const remaining = Math.max(0, config.limit - timestamps.length);
        
        // resetTime = when oldest timestamp expires = first slot frees up
        const resetTime = timestamps.length > 0 ? timestamps[0]! + config.windowMs : now + config.windowMs;

        let retryAfter: number | undefined;
        if(!allowed) {
            // How many of the oldest timestamps need to expire
            // before weight slots become available?
            const needed = (countBeforeRequest + config.weight) - config.limit;
            const unblockIndex = Math.min(needed - 1, timestamps.length - 1);
            const unblockTs = timestamps[unblockIndex]!;
            const msUntilUnblock = Math.max(0, (unblockTs + config.windowMs) - now);
            retryAfter = Math.ceil(msUntilUnblock / 1000);
        }

        return {
            allowed,
            remaining,
            limit: config.limit,
            resetTime,
            ...(retryAfter !== undefined ? { retryAfter } : {})
        }
    } 
}

/**
 * Sliding Window Counter rate limiting algorithm.
 *
 * This algorithm approximates a true sliding window by combining:
 * - Current window request count
 * - Previous window request count (weighted by time decay)
 *
 * 🧠 How it works:
 * - Time is divided into fixed windows (like Fixed Window)
 * - Previous window contributes partially based on how far we are into the current window
 * - This creates a smooth transition between windows and avoids burst spikes
 *
 * 📉 Formula:
 * effectiveCount =
 *   (previousCount × decayWeight) + currentCount
 *
 * Where:
 * - decayWeight decreases linearly from 1 → 0 over the window duration
 *
 * ⚖️ Trade-offs:
 * ✔ More accurate than Fixed Window
 * ✔ Much cheaper than Sliding Log (no per-request storage)
 * ✖ Slight approximation (not exact like log-based)
 *
 * 🧪 Complexity:
 * - Time: O(1)
 * - Space: O(1)
 *
 * @implements {RateLimitAlgorithm}
*/
export class SlidingWindowCountAlgorithm implements RateLimitAlgorithm {
    public readonly name = "sliding-window-count";

    /**
     * Processes a request using the sliding window counter algorithm.
     *
     * Determines whether a request is allowed by calculating an
     * "effective count" using both current and previous window data.
     *
     * Handles:
     * - Initial requests (no state)
     * - Window rollover (single + double)
     * - Weighted contribution from previous window
     *
     * @param state - Previous rate limit state from the store
     * @param config - Algorithm configuration (limit, window, weight)
     *
     * @returns Object containing:
     * - newState: Updated state to persist
     * - result: Rate limit decision and metadata
    */
    public process(
        state: RateLimitState | null, 
        config: AlgorithmConfig
    ): { newState: RateLimitState; result: RateLimitResult; } {
        const now = Date.now(); // get the current time
        const windowStart = this.calculateWindowStart(now, config.windowMs);  // get the current window starting

        // resolve counts from state
        let currentCount: number;
        let previousCount: number;
        
        // Check if it's a intitial request
        if(!state || state.type !== "sliding-count") {
            // First request ever — no history
            currentCount = 0;
            previousCount = 0;
        } else {
            const s = state.data;

            if(windowStart > s.windowStart + config.windowMs) {
                // Double rollover — two full windows passed
                // All previous data is irrelevant
                currentCount = 0;
                previousCount = 0;
            } else if(windowStart > s.windowStart) {
                // Single rollover — current becomes previous, reset current
                currentCount = 0;
                previousCount = s.currentCount;
            } else {
                // Same window — just use existing counts
                currentCount = s.currentCount;
                previousCount = s.previousCount;
            }
        }

        // How far into the current window are we? (0.0 → 1.0)
        const elapsed = now - windowStart; // ms into current window

        // How much weight does previous window carry?
        // At elapsed=0 (window just started) → previousWeight=1.0 (full previous)
        // At elapsed=windowMs (window ending)  → previousWeight=0.0 (previous irrelevant)
        const previousWeight = (config.windowMs - elapsed) / config.windowMs;

        const effectiveCount = (previousCount * previousWeight) + currentCount;

        // Check and update
        const allowed = effectiveCount + config.weight <= config.limit;
        const newCurrentCount = allowed ? currentCount + config.weight : currentCount;

        return {
            newState: this.buildState(newCurrentCount, previousCount, windowStart, now, config),
            result: this.buildResult(
                allowed, effectiveCount, newCurrentCount, previousCount, windowStart, now, config
            )
        }
    }

    /**
     * Calculates the start timestamp of the current window.
     *
     * @param now - Current timestamp (ms)
     * @param windowMs - Window size in milliseconds
     * @returns Start of the current window (ms)
    */
    private calculateWindowStart(now: number, windowMs: number): number {
        return Math.floor(now / windowMs) * windowMs;
    }

    /**
     * Builds the new state to persist in the store.
     *
     * Includes:
     * - Current window count
     * - Previous window count
     * - Window start timestamp
     * - TTL covering current + next window (for smooth rollover)
     *
     * @param currentCount - Count in current window
     * @param previousCount - Count in previous window
     * @param windowStart - Start of current window
     * @param now - Current timestamp
     * @param config - Algorithm configuration
     *
     * @returns RateLimitState object
    */
    private buildState(
        currentCount: number,
        previousCount: number,
        windowStart: number,
        now: number,
        config: AlgorithmConfig
    ): RateLimitState {
        const windowEnd = windowStart + config.windowMs;
        return {
            type: "sliding-count",
            data: { currentCount, previousCount, windowStart },
            ttl: Math.max(1, (windowEnd - now) + config.windowMs) // time until window ends
        };
    }
    
    /**
     * Builds the final rate limit result.
     *
     * 🧠 Key Idea:
     * The "effective count" decreases over time as the previous window
     * contribution decays linearly. This allows blocked requests to
     * become valid again *before* the window fully resets.
     *
     * ⏳ Retry-After Calculation:
     * - Solves when the effective count drops enough to allow a request
     * - Uses inverse of decay formula to estimate unblock time
     *
     * 📊 Returned fields:
     * - allowed: Whether request is permitted
     * - remaining: Remaining capacity in current window
     * - limit: Max allowed requests
     * - resetTime: When window fully resets
     * - retryAfter: Seconds until request is allowed again (if blocked)
     *
     * @param allowed - Whether request is allowed
     * @param effectiveCount - Weighted request count
     * @param currentCount - Current window count
     * @param previousCount - Previous window count
     * @param previousWeight - Decay weight (1 → 0)
     * @param windowStart - Start of current window
     * @param now - Current timestamp
     * @param config - Algorithm configuration
     *
     * @returns RateLimitResult
     */
    private buildResult(
        allowed: boolean,
        effectiveCount: number,
        currentCount: number,
        previousCount: number,
        windowStart: number,
        now: number,
        config: AlgorithmConfig
    ): RateLimitResult {
        const windowEnd = windowStart + config.windowMs;

        // remaining = how many request left in window
        const efectiveAfter = allowed ? effectiveCount + config.weight : effectiveCount;
        const remaining = Math.max(0, Math.floor(config.limit - efectiveAfter));
        // const remaining = Math.max(0, Math.floor(config.limit - effectiveCount));

        // resetTime = end of current window (when counts fully reset)
        const resetTime = windowEnd;

        let retryAfter: number | undefined;
        if(!allowed) {
            // How much does effectiveCount need to drop for weight to fit?
            // effectiveCount drops as elapsed increases (previousWeight decreases)
            // Solve: (previousCount × newPreviousWeight) + currentCount + weight <= limit
            // newPreviousWeight = (limit - currentCount - weight) / previousCount
            if(previousCount > 0) {
                const targetWeight = (config.limit - currentCount - config.weight) / previousCount;
                // targetWeight = (windowMs - newElapsed) / windowMs
                // newElapsed   = windowMs × (1 - targetWeight)
                const newElapsed = config.windowMs * (1 - targetWeight);
                const msUntilUnblock = Math.max(0, (windowStart + newElapsed) - now);
                retryAfter = Math.ceil(msUntilUnblock / 1000);
            } else {
                // No previous window — blocked purely by currentCount
                // Must wait for next window
                retryAfter = Math.ceil((windowEnd - now) / 1000);
            }
        }

        return {
            allowed,
            remaining,
            limit: config.limit,
            resetTime,
            ...(retryAfter !== undefined ? { retryAfter } : {})
        };
    }
}