import type { FastifyRequest, FastifyReply } from "fastify";
import type { RateLimiter } from "../core/rateLimiter";

/**
 * Fastify middleware for applying rate limiting using the RateLimiter.
 *
 * This middleware:
 * - Executes the rate limiter for each incoming request
 * - Attaches standard rate limit headers to the response
 * - Blocks requests that exceed the configured limit
 *
 * 🔒 Behavior:
 * - Allows request if within limit
 * - Responds with HTTP 429 (Too Many Requests) if exceeded
 *
 * 📡 Headers set (if enabled):
 * - X-RateLimit-Limit
 * - X-RateLimit-Remaining (only when >= 0)
 * - X-RateLimit-Reset (in seconds)
 * - Retry-After (only when request is blocked)
 *
 * ⚠️ Notes:
 * - If the store fails and `failOpen` is enabled, requests may still pass
 * - Errors are re-thrown to let Fastify handle them via its error lifecycle
 *
 * @template TReq - Underlying request type (e.g. FastifyRequest)
 *
 * @param limiter - Configured RateLimiter instance
 * @returns Fastify-compatible middleware function
 *
 * @example
 * ```ts
 * import Fastify from "fastify";
 * import { fastifyRateLimiter } from "your-lib";
 *
 * const app = Fastify();
 *
 * const limiter = new RateLimiter({
 *   limit: 100,
 *   windowMs: 60_000
 * });
 *
 * app.addHook("onRequest", fastifyRateLimiter(limiter));
 *
 * app.get("/", async () => {
 *   return { ok: true };
 * });
 *
 * await app.listen({ port: 3000 });
 * ```
*/
export const fastifyRateLimiter = <TReq = unknown>(limiter: RateLimiter<TReq>) => {
    return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
        try {
            const result = await limiter.handler(req as unknown as TReq, reply); // get result 

            // get config 
            const config = limiter.getConfig();

            // set headers if it's not disable
            if(config.headers !== false) {
                reply.header("X-RateLimit-Limit", result.limit);

                // Don't send header when remaining is unknown (store failure = -1)
                if(result.remaining >= 0) {
                    reply.header("X-RateLimit-Remaining", result.remaining);
                }

                reply.header("X-RateLimit-Reset", Math.ceil(result.resetTime / 1000));

                if(!result.allowed && result.retryAfter) {
                    reply.header("Retry-After", result.retryAfter);
                }
            }

            // limit is reached stop request
            if(!result.allowed) {
                return reply.status(429).send({
                    message: "Too Many Requests",
                    retryAfter: result.retryAfter
                });
            }
        } catch(error) {
            // Fastify error handling — throw to let Fastify handle it
            throw error;
        }
    };
};