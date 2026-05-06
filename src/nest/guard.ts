import { Injectable, HttpException, HttpStatus, Inject } from "@nestjs/common";
import type { CanActivate, ExecutionContext } from "@nestjs/common";
import { RateLimiter } from "../core/rateLimiter";

/**
 * NestJS Guard for enforcing rate limits using the RateLimiter.
 *
 * This guard intercepts incoming HTTP requests and:
 * - Executes the rate limiter
 * - Sets standard rate limit headers
 * - Blocks requests when the limit is exceeded
 *
 * 🔒 Behavior:
 * - Allows request if within limit
 * - Throws HTTP 429 (Too Many Requests) if exceeded
 *
 * 📡 Headers set (if enabled):
 * - X-RateLimit-Limit
 * - X-RateLimit-Remaining
 * - X-RateLimit-Reset
 * - Retry-After (only when blocked)
 *
 * @template TReq - Request type (e.g. Express.Request)
 */
@Injectable()
export class RateLimitGuard<TReq = unknown> implements CanActivate {
    /**
     * Creates a new RateLimitGuard instance.
     *
     * @param limiter - RateLimiter instance injected via NestJS DI
    */
    constructor(@Inject(RateLimiter) private readonly limiter: RateLimiter<TReq>) {}

    /**
     * Determines whether the current request is allowed.
     *
     * Executes the rate limiter and:
     * - Attaches rate limit headers to the response
     * - Throws an exception if the request exceeds the limit
     *
     * @param context - NestJS execution context
     * @returns Promise resolving to true if request is allowed
     *
     * @throws {HttpException} When rate limit is exceeded (429)
    */
    public async canActivate(context: ExecutionContext): Promise<boolean> {
        const http = context.switchToHttp();
        const req = http.getRequest<TReq>();
        const res = http.getResponse();
        const result = await this.limiter.handler(req, res);
        const config = this.limiter.getConfig();

        // Set headers if not disabled
        if(config.headers !== false) {
            res.setHeader("X-RateLimit-Limit", result.limit);

            if(result.remaining >= 0) {
                res.setHeader("X-RateLimit-Remaining", result.remaining);
            }

            res.setHeader("X-RateLimit-Reset", Math.ceil(result.resetTime / 1000));

            if(!result.allowed && result.retryAfter) {
                res.setHeader("Retry-After", result.retryAfter);
            }
        }

        // Block the request if not allowed
        if(!result.allowed) {
            throw new HttpException(
                {
                    statusCode: HttpStatus.TOO_MANY_REQUESTS,
                    message: "Too Many Requests",
                    retryAfter: result.retryAfter
                },
                HttpStatus.TOO_MANY_REQUESTS
            );
        }

        return true;
    }
}