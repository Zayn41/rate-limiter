import type { RateLimitResult } from "./result";
import type { RateLimitState } from "./state";

/**
 * Configuration passed to all rate limiting algorithms.
 * 
 * This defines the shared parameters used by token bucket,
 * fixed window, and sliding window implementations.
 */
export interface AlgorithmConfig {
    /**
     * Maximum number of requests/tokens allowed in the window.
     */
    limit: number;

    /**
     * Time window in milliseconds for rate limiting.
     */
    windowMs: number;

    /**
     * Weight of each request.
     * 
     * Useful for cost-based rate limiting where some requests
     * consume more quota than others.
     * 
     * @default 1
     */
    weight: number;
}

/**
 * Core interface for all rate limiting algorithms.
 * 
 * Each algorithm must implement this interface to ensure
 * consistent behavior across different strategies
 * (token bucket, fixed window, sliding window, etc.).
 */
export interface RateLimitAlgorithm {
    /**
     * Unique algorithm name identifier.
     */
    name: string;

    /**
     * Processes a request and returns updated state + result.
     * 
     * @param state - Current stored state for the key (or null if new)
     * @param config - Shared algorithm configuration
     * 
     * @returns Updated state and rate limit decision result
     */
    process(
        state: RateLimitState | null,
        config: AlgorithmConfig
    ) : { newState: RateLimitState, result: RateLimitResult }
}