import type { DynamicModule } from "@nestjs/common";
import type { RateLimitConfig } from "../types/config";
import { Module, Global } from "@nestjs/common";
import { RateLimiter } from "../core/rateLimiter";
import { RateLimitGuard } from "./guard";

/**
 * NestJS module for integrating the RateLimiter.
 *
 * Provides:
 * - A configured RateLimiter instance
 * - RateLimitGuard for request throttling
 *
 * This module is marked as global, so it does not need to be
 * imported in every module after initialization.
*/
@Global()
@Module({})
export class RateLimitModule {
    /**
     * Registers the RateLimiter with the provided configuration.
     *
     * @param config - Rate limiter configuration options
     * @returns Dynamic NestJS module
     *
     * @example
     * ```ts
     * RateLimitModule.forRoot({
     *   limit: 100,
     *   windowMs: 60_000,
     * })
     * ```
    */
    static forRoot<TReq = unknown>(config: RateLimitConfig<TReq>): DynamicModule {
        const limiter = new RateLimiter(config);
        return {
            module: RateLimitModule,
            providers: [
                {
                    provide: RateLimiter,
                    useValue: limiter
                },
                RateLimitGuard
            ],
            exports: [RateLimiter, RateLimitGuard]
        };
    }
}
