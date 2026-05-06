import type { Context, Next } from "hono";
import { RateLimiter } from "../core/rateLimiter";

/**
 * Hono middleware for applying rate limiting using the RateLimiter.
 *
 * This middleware:
 * - Executes the rate limiter for each incoming request
 * - Sets standard rate limit headers
 * - Blocks requests that exceed the configured limit
 *
 * 🔒 Behavior:
 * - Allows request if within limit
 * - Returns HTTP 429 (Too Many Requests) if exceeded
 *
 * 📡 Headers set (if enabled):
 * - X-RateLimit-Limit
 * - X-RateLimit-Remaining
 * - X-RateLimit-Reset
 * - Retry-After (only when blocked)
 *
 * @template TReq - Underlying request type (e.g. Request from Fetch API)
 *
 * @param limiter - Configured RateLimiter instance
 * @returns Hono-compatible middleware function
 *
 * @example
 * ```ts
 * import { Hono } from "hono";
 * import { hono as rateLimit } from "your-lib";
 *
 * const app = new Hono();
 *
 * app.use(
 *   rateLimit(
 *     new RateLimiter({
 *       limit: 100,
 *       windowMs: 60_000
 *     })
 *   )
 * );
 * ```
*/
export const honoRateLimiter = <TReq = unknown>(limiter: RateLimiter<TReq>) => {
    return async (c: Context, next: Next): Promise<Response | void> => {
        try {
            const result = await limiter.handler(
                c.req.raw as unknown as TReq, 
                c
            );
            const config = limiter.getConfig(); 
            
            // Set headers if not disabled
            if(config.headers !== false) {
                c.header("X-RateLimit-Limit", String(result.limit));

                if(result.remaining >= 0) {
                    c.header("X-RateLimit-Remaining", String(result.remaining));
                }

                c.header("X-RateLimit-Reset", String(Math.ceil(result.resetTime / 1000)));

                if(!result.allowed && result.retryAfter) {
                    c.header("Retry-After", String(result.retryAfter));
                }
            }

            // Request reached the limit bloacked it
            if(!result.allowed) {
                return c.json(
                    {
                        message: "Too Many Requests",
                        retryAfter: result.retryAfter
                    },
                    429
                );
            }

            await next();
        } catch(error) {
            return c.json({ message: "Internal Server Error" }, 500);
        }
    };
};