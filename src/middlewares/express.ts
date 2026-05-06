import type { RateLimiter } from "../core/rateLimiter";

/**
 * Express middleware for applying rate limiting using the RateLimiter.
 *
 * This middleware:
 * - Executes the rate limiter for each incoming request
 * - Sets standard rate limit headers on the response
 * - Blocks requests that exceed the configured limit
 *
 * 🔒 Behavior:
 * - Calls `next()` if request is within limit
 * - Responds with HTTP 429 (Too Many Requests) if exceeded
 *
 * 📡 Headers set (if enabled):
 * - X-RateLimit-Limit
 * - X-RateLimit-Remaining (only when >= 0)
 * - X-RateLimit-Reset (in seconds)
 * - Retry-After (only when blocked)
 *
 * ⚠️ Notes:
 * - If the store fails and `failOpen` is enabled, requests may still pass
 * - Errors are forwarded to Express error middleware via `next(error)`
 *
 * @template TReq - Underlying request type (e.g. Express Request)
 *
 * @param limiter - Configured RateLimiter instance
 * @returns Express-compatible middleware function
 *
 * @example
 * ```ts
 * import express from "express";
 * import { expressRateLimiter } from "your-lib";
 *
 * const app = express();
 *
 * const limiter = new RateLimiter({
 *   limit: 100,
 *   windowMs: 60_000
 * });
 *
 * app.use(expressRateLimiter(limiter));
 *
 * app.get("/", (req, res) => {
 *   res.json({ ok: true });
 * });
 *
 * app.listen(3000);
 * ```
*/
export const expressRateLimiter = <TReq = unknown>(limiter: RateLimiter<TReq>) => {
    return async (req: any, res: any, next: any): Promise<void> => {
        try {
            const result = await limiter.handler(req, res); // get result
            const config = limiter.getConfig(); // get config

            // Set headers unless disabled in config
            if(config.headers !== false) {
                res.setHeader("X-RateLimit-Limit", result.limit);

                // Don't send header when remaining is unknown (store failure = -1)
                if(result.remaining >= 0) {
                    res.setHeader("X-RateLimit-Remaining", result.remaining);
                }

                res.setHeader("X-RateLimit-Reset", Math.ceil(result.resetTime / 1000));

                if(!result.allowed && result.retryAfter) {
                    res.setHeader("Retry-After", result.retryAfter);
                }
            }

            if(!result.allowed) {
                res.status(429).json({
                    message: "Too Many Requests",
                    retryAfter: result.retryAfter
                });
                return;
            }
            
            next();
        } catch(error) {
            next(error);
        }
    }
};