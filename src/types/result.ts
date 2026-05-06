/**
 * Result returned after evaluating a rate limit request.
 * 
 * This object represents the decision made by the rate limiter
 * and contains metadata useful for headers, logging, and client feedback.
 */
export interface RateLimitResult {
    /**
     * Whether the request is allowed to proceed.
     * 
     * - `true` → request can continue
     * - `false` → rate limit exceeded
    */
    allowed: boolean;

    /**
     * Number of remaining requests/tokens available in the current window.
     */
    remaining: number;

    /**
     * Maximum allowed requests/tokens for the current window.
     */
    limit: number;

    /**
     * Timestamp (in milliseconds) when the rate limit resets.
     * 
     * Can be used to calculate wait time or set response headers.
     */
    resetTime: number;

    /**
     * Time in seconds until the next request is allowed.
     * 
     * Typically used when `allowed = false`.
     * 
     * @example
     * ```ts
     * res.setHeader("Retry-After", result.retryAfter);
     * ```
     */
    retryAfter?: number;

    /**
     * The key used for rate limiting (e.g., IP, user ID).
     * 
     * Useful for debugging, logging, and observability.
     */
    key?: string;
}