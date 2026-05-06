/**
 * Context object representing a single rate limit evaluation request.
 * 
 * This is passed through the entire rate limiting pipeline and plugins,
 * and contains all metadata required to make rate limiting decisions.
 */
export interface RateLimitContext {
    /**
     * Unique rate limit key used in the store (e.g., IP, user ID, custom key).
     */
    key: string;

    /**
     * Client IP address of the request.
     */
    ip: string;

    /**
     * Request path (e.g., "/api/v1/users").
     */
    path: string;

    /**
     * HTTP method (GET, POST, etc.).
     */
    method: string;

    /**
     * Timestamp when the request was processed (in milliseconds).
     */
    timestamp: number;

    /**
     * Weight of this request in rate limiting calculations.
     * 
     * Useful for:
     * - cost-based rate limiting
     * - heavier endpoints consuming more quota
     * 
     * @default 1
     */
    weight: number;

    /**
     * Optional authenticated user identifier.
     * Useful when rate limiting per user instead of IP.
     */
    userId?: string;

    /**
     * Optional route identifier (useful for grouping endpoints).
     * Example: "auth.login", "user.create"
     */
    route?: string;
}