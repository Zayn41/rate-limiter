import type { RateLimitStore } from "./store.ts";
import type { RateLimitPlugin } from "./plugin.ts";
import type { RateLimitError } from "./error.ts";
import type { RateLimitResult } from "./result.ts";

/**
    * Rate limiting algorithms supported by the library.
    * 
    * @enum {string}
    * @readonly
    * 
    * @example
    * ```typescript
    * // Token bucket: Gradual token refill
    * const config = { algorithm: Algorithm.TOKEN };
    * 
    * // Fixed window: Reset counter at fixed intervals
    * const config = { algorithm: Algorithm.FIXED };
    * 
    * // Sliding window: More accurate, slightly higher overhead
    * const config = { algorithm: Algorithm.SLIDING };
    * ```
*/

// Algorithm to use (default : Token)
export enum Algorithm {
    /** Token bucket algorithm - tokens refill at a constant rate */
    TOKEN = "token-bucket",
    /** Fixed window counter - resets at fixed intervals */
    FIXED = "fixed-window",
    /** Sliding window log - highest precision, more overhead */
    SLIDING_LOG = "sliding-window-log",

    /**Sliding window count - highly optimised, but approximation */
    SLIDING_COUNT = "sliding-window-count"
}

/**
    * Function to generate a unique key from an incoming request.
    * Used to identify and track rate limits for different clients/users.
    * 
    *@template TReq - The request type (e.g., Express Request, fetch Request, custom object)
    * @param req - The incoming request object
    * @returns A unique string key or a Promise that resolves to a key
    * 
    * @example
    * ```typescript
    * // By IP address (default behavior)
    * const keyGenerator = (req) => req.ip || "unknown";
    * 
    * // By user ID
    * const keyGenerator = (req) => `user:${req.user.id}`;
    * 
    * // By combination
    * const keyGenerator = (req) => `${req.user.id}:${req.path}`;
    * 
    * // Async key generation
    * const keyGenerator = async (req) => {
    *   const userId = await getUserId(req);
    *   return `api:${userId}`;
    * };
    * ```
*/
export type KeyGenerator<TReq = unknown> = (req: TReq) => string | Promise<string>;

/**
    * Function to determine whether a request should be skipped from rate limiting.
    * Useful for exempting certain clients, paths, or request types.
    * 
    * @template TReq - The request type (e.g., Express Request, fetch Request, custom object)
    * @param req - The incoming request object
    * @returns true to skip rate limiting for this request, false to apply rate limiting, or a Promise resolving to either
    * 
    * @example
    * ```typescript
    * // Skip health check endpoints
    * const skip = (req) => req.path === "/health";
    * 
    * // Skip authenticated admin users
    * const skip = (req) => req.user?.isAdmin === true;
    * 
    * // Skip based on custom header
    * const skip = (req) => req.headers["x-bypass-ratelimit"] === "secret-token";
    * 
    * // Async skip logic
    * const skip = async (req) => {
    *   const isWhitelisted = await checkWhitelist(req.ip);
    *   return isWhitelisted;
    * };
    * ```
*/
export type Skip<TReq = unknown> = (req: TReq) => boolean | Promise<boolean>;

/**
    * Configuration object for rate limiting behavior.
    * Controls algorithm, store, key generation, headers, and custom handlers.
    * 
    * @template TReq - The request type (e.g., Express Request, fetch Request, custom object)
    * 
    * @example
    * ```typescript
    * const config: RateLimitConfig = {
    *   windowMs: 15 * 60 * 1000,        // 15 minutes
    *   limit: 100,                       // 100 requests per window
    *   store: new MemoryStore(),
    *   keyGenerator: (req) => req.ip,
    *   algorithm: Algorithm.TOKEN,
    *   standardHeaders: true,
    *   legacyHeaders: false
    * };
    * ```
*/
export interface RateLimitConfig<TReq = unknown> {
    /**
        * Time window in milliseconds during which the rate limit applies.
        * After this period, the counter resets (or tokens refill).
        * 
        * @type {number}
        * @example
        * ```typescript
        * windowMs: 15 * 60 * 1000  // 15 minutes
        * windowMs: 60 * 1000       // 1 minute
        * windowMs: 1000            // 1 second
        * ```
    */
    windowMs: number;

    /**
        * Maximum number of requests (or tokens) allowed per window.
        * Once exceeded, requests are rejected until the window resets.
        * 
        * @type {number}
        * @example
        * ```typescript
        * limit: 100      // 100 requests per window
        * limit: 1000     // 1000 requests per window
        * limit: 10       // 10 requests per window (strict)
        * ```
    */
    limit: number;

    /**
        * Cost multiplier for each request.
        * Useful for charging different costs to different request types.
        * 
        * @type {number}
        * @default 1
        * 
        * @example
        * ```typescript
        * // Default: 1 token per request
        * weight: 1
        * 
        * // Expensive operation: costs 5 tokens
        * weight: 5
        * 
        * // Cheap operation: costs 0.5 tokens
        * weight: 0.5
        * ```
    */
    weight?: number;

    /**
        * Algorithm to use for rate limiting.
        * Defaults to TOKEN_BUCKET (token bucket algorithm).
        * 
        * @type {Algorithm}
        * @default Algorithm.TOKEN
        * 
        * @see {@link Algorithm}
        * 
        * @example
        * ```typescript
        * algorithm: Algorithm.TOKEN      // Recommended: smooth token refill
        * algorithm: Algorithm.FIXED      // Simple: fixed window resets
        * algorithm: Algorithm.SLIDING    // Accurate: sliding window log
        * ```
    */
    algorithm?: Algorithm;

    /**
        * Primary storage backend for rate limit data.
        * Can be MemoryStore (in-process) or RedisStore (distributed).
        * 
        * @type {RateLimitStore}
        * @required
        * 
        * @example
        * ```typescript
        * // In-memory (single server)
        * store: new MemoryStore()
        * 
        * // Redis (distributed/multi-server)
        * store: new RedisStore(redisClient)
        * ```
    */
    store: RateLimitStore;

    /**
        * Prefix to prepend to all cache keys.
        * Useful for namespacing, debugging, or running multiple rate limiters.
        * 
        * @type {string}
        * @default "rl:" (rate-limit)
        * 
        * @example
        * ```typescript
        * keyPrefix: "api:v1"           // Keys become "api:v1:user:123"
        * keyPrefix: "auth"             // Keys become "auth:user:456"
        * keyPrefix: "search"           // Keys become "search:query:789"
        * ```
    */
    keyPrefix?: string;

    /**
        * Function to derive a unique key from the incoming request.
        * By default, uses the client's IP address.
        * 
        * @type {KeyGenerator<TReq>}
        * @default (req) => req.ip || "unknown"
        * 
        * @see {@link KeyGenerator}
        * 
        * @example
        * ```typescript
        * // By user ID (for authenticated users)
        * keyGenerator: (req) => `user:${req.user.id}`
        * 
        * // By API key
        * keyGenerator: (req) => req.headers["x-api-key"]
        * 
        * // By combination of factors
        * keyGenerator: (req) => `${req.user.id}:${req.path}`
        * ```
    */
    keyGenerator?: KeyGenerator<TReq>;

    /**
        * Include RateLimit-* headers in responses.
        * Complies with IETF draft specification for rate limit headers.
        * 
        * @type {boolean}
        * @default true
        * 
        * Headers included:
        * - RateLimit-Limit: Total requests allowed
        * - RateLimit-Remaining: Requests remaining in current window
        * - RateLimit-Reset: Unix timestamp when window resets
        * 
        * @example
        * ```typescript
        * // Enable standard headers
        * headers: true
        * 
        * // Response headers:
        * // RateLimit-Limit: 100
        * // RateLimit-Remaining: 45
        * // RateLimit-Reset: 1713312000
        * ```
    */

    // Attach X-RateLimit-* headers to responses (default: true) 
    headers?: boolean;

    /**
        * Include legacy X-RateLimit-* headers in responses.
        * For backward compatibility with older clients.
        * 
        * @type {boolean}
        * @default false
        * 
        * Legacy headers included:
        * - X-RateLimit-Limit
        * - X-RateLimit-Remaining
        * - X-RateLimit-Reset
        * 
        * @example
        * ```typescript
        * // Enable legacy headers
        * legacyHeaders: true
        * 
        * // Response headers:
        * // X-RateLimit-Limit: 100
        * // X-RateLimit-Remaining: 45
        * // X-RateLimit-Reset: 1713312000
        * ```
    */
    legacyHeaders?: boolean;

    /**
        * Use IETF standard RateLimit-* headers (alternative to legacy headers).
        * Recommended for new implementations.
        * 
        * @type {boolean}
        * @default true
        * 
        * @example
        * ```typescript
        * // Use IETF standard headers
        * standardHeaders: true
        * ```
    */
    standardHeaders?: boolean;

    /**
        * Fail open behavior when the store is unavailable.
        * If true, allows all requests through when store fails.
        * If false, rejects all requests when store fails (fail closed).
        * 
        * @type {boolean}
        * @default true
        * 
        * @example
        * ```typescript
        * // Fail open: Allow requests if Redis goes down
        * failOpen: true
        * 
        * // Fail closed: Reject requests if store is unavailable
        * failOpen: false
        * ```
    */
    // Fail open — allow requests when the store is unavailable (default: true) 
    failOpen?: boolean;

    /**
        * Function to determine if a request should be skipped from rate limiting.
        * Useful for exempting certain paths, users, or request types.
        * 
        * @type {Skip<TReq>}
        * 
        * @see {@link Skip}
        * 
        * @example
        * ```typescript
        * // Skip health check endpoints
        * skip: (req) => req.path === "/health"
        * 
        * // Skip authenticated admins
        * skip: (req) => req.user?.isAdmin === true
        * 
        * // Skip with async logic
        * skip: async (req) => {
        *   const isWhitelisted = await db.checkWhitelist(req.ip);
        *   return isWhitelisted;
        * }
        * ```
    */
    skip?: Skip<TReq>;

    /**
        * Array of plugins for extensibility.
        * Plugins can hook into rate limiting events for logging, metrics, tracing, etc.
        * 
        * @type {RateLimitPlugin[]}
        * @optional
        * 
        * @see {@link RateLimitPlugin}
        * 
        * @example
        * ```typescript
        * plugins: [
        *   new PrometheusPlugin(),    // Collect metrics
        *   new LoggerPlugin(),        // Log rate limit events
        *   new TracingPlugin(),       // Distributed tracing
        * ]
        * ```
    */
    // Plugins for logging, metrics, tracing, etc. 
    plugins?: RateLimitPlugin[];

    /**
        * Custom error handler for rate limiting errors.
        * Called when an error occurs during rate limit checking.
        * 
        * @type {Function}
        * @param error - The RateLimitError that occurred
        * @param req - The incoming request
        * @param res - The response object (framework-specific)
        * 
        * @example
        * ```typescript
        * onError: (error, req, res) => {
        *   console.error(`Rate limit error: ${error.message}`);
        *   res.status(500).json({ error: "Internal server error" });
        * }
        * ```
    */
    // Override default error handling 
    onError?: (error: RateLimitError, req: TReq, res: unknown) => void;

    /**
        * Custom handler when rate limit is exceeded.
        * Called instead of (or in addition to) rejecting the request.
        * 
        * @type {Function}
        * @param req - The incoming request
        * @param res - The response object (framework-specific)
        * @param result - The rate limit result (remaining, reset time, etc.)
        * 
        * @example
        * ```typescript
        * onLimitReached: (req, res, result) => {
        *   res.status(429).json({
        *     error: "Too many requests",
        *     retryAfter: result.resetAfterMs
        *   });
        * }
        * ```
    */
    // Custom action when the rate limit is exceeded 
    onLimitReached?: (req: TReq, res: unknown, result: RateLimitResult) => void;
}