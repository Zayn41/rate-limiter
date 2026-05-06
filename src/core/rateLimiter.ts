import type { RateLimitContext } from "../types/context";
import type { RateLimitAlgorithm } from "../types/algorithm";
import type { RateLimitResult } from "../types/result";
import type { RateLimitConfig } from "../types/config";
import { Algorithm } from "../types/config";
import { FixedWindowAlgorithm } from "../algorithms/fixedWindow";
import { TokenBucketAlgorithm } from "../algorithms/tokenBucket";
import { SlidingWindowLogAlgorithm } from "../algorithms/slidingWindow";
import { SlidingWindowCountAlgorithm } from "../algorithms/slidingWindow";
import { validateConfig } from "../validators/config";
import { RateLimitError } from "../types/error";

/**
 * Core rate limiting engine.
 *
 * The `RateLimiter` coordinates:
 * - Algorithm selection (Token Bucket, Fixed Window, Sliding Window, etc.)
 * - Store interaction (Memory, Redis, or custom)
 * - Request lifecycle hooks (plugins, skip, error handling)
 * - Framework-agnostic execution via middleware adapters
 *
 * 🚀 Features:
 * - Supports multiple rate limiting algorithms
 * - Atomic execution when store provides `execute()` (e.g. Redis + Lua)
 * - Plugin system for observability and side effects
 * - Fail-open / fail-closed behavior
 * - Flexible key generation (IP, userId, custom logic)
 *
 * 🔒 Behavior:
 * - Each request is evaluated via `handler()`
 * - If within limit → allowed
 * - If exceeded → blocked and metadata returned
 *
 * ⚙️ Execution Flow:
 * 1. Check `skip` condition
 * 2. Resolve request key (IP or custom)
 * 3. Build request context
 * 4. Run `onRequestStart` plugins
 * 5. Execute algorithm (atomic via store or in-memory fallback)
 * 6. Run `onRequestEnd` plugins
 * 7. Trigger `onLimitReached` if blocked
 * 8. Handle errors via `failOpen` or throw
 *
 * @template TReq - Underlying request type (Express, Fastify, Fetch API, etc.)
 *
 * @example
 * ```ts
 * import { RateLimiter } from "your-lib";
 *
 * const limiter = new RateLimiter({
 *   limit: 100,
 *   windowMs: 60_000,
 *   algorithm: "token-bucket",
 *   store: new MemoryStore(),
 * });
 *
 * const result = await limiter.handler(req, res);
 *
 * if (!result.allowed) {
 *   console.log("Rate limit exceeded");
 * }
 * ```
*/
export class RateLimiter<TReq = unknown> {
    private readonly algorithm: RateLimitAlgorithm;

    constructor(private config: RateLimitConfig<TReq>) {
        validateConfig(config);
        this.algorithm = this.selectAlgorithm();
    }

    /**
     * Main entry point for processing a request.
     *
     * This method is called by all framework adapters (Express, Fastify, Hono, NestJS).
     * It evaluates whether the request should be allowed based on the configured
     * algorithm and store.
     *
     * 🧠 Logic:
     * - Applies `skip` logic if defined
     * - Resolves a unique key for the request
     * - Executes rate limiting algorithm (atomic if supported)
     * - Handles errors via `failOpen` or throws
     *
     * @param req - Incoming request object (framework-specific)
     * @param res - Response object (used in callbacks/hooks)
     * @returns RateLimitResult containing decision and metadata
     *
     * @throws {RateLimitError} When `failOpen` is disabled and an error occurs
    */
    public async handler(req: TReq, res: unknown): Promise<RateLimitResult> {
        const now = Date.now(); // get current time
        const weight = this.config.weight ?? 1;  // get weight if provided otherwise fall to 1

        // Check for skip
        try {
            const shouldSkip = await this.config.skip?.(req);
            if(shouldSkip) {
                return this.buildSkipResult(now);
            }
        } catch(err) {
            return this.handleError(err, req, res, now);
        }

        // key generation
        let key: string;
        try {
            key = await this.resolvekey(req);
        } catch(err) {
            return this.handleError(err, req, res, now);
        }

        // build the context
        const ctx = this.buildContext(key, req, now, weight);

        // plugin onRequestStart
        await this.runPlugins("onRequestStart", ctx);

        let result: RateLimitResult;
        
        try {
            // Use atomic Lua execution if store supports it
            if(typeof this.config.store.execute === "function") {
                result = await this.config.store.execute(key, [
                    this.config.algorithm ?? Algorithm.TOKEN,
                    this.config.limit,
                    this.config.windowMs,
                    weight,
                    now
                ]);
                result = { ...result, key };
            } else {
                const state = await this.config.store.get(key); // get data by key
                const output = this.algorithm.process(state, {
                    limit: this.config.limit,
                    windowMs: this.config.windowMs,
                    weight
                });

                await this.config.store.set(key, output.newState, output.newState.ttl);
                result = { ...output.result, key };
            }
        } catch(err) {
            return this.handleError(err, req, res, now, ctx);
        }

        // plugin onRequestEnd
        await this.runPlugins("onRequestEnd", ctx, result);

        // handle limit reached
        if(!result.allowed) {
            this.config.onLimitReached?.(req, res, result);
        }

        return result;
    }

    // This method will help to select the algorithm default algorithm - Token Bucket
    private selectAlgorithm(): RateLimitAlgorithm {
        switch(this.config.algorithm ?? Algorithm.TOKEN) {
            case Algorithm.TOKEN:
                return new TokenBucketAlgorithm();
            case Algorithm.FIXED:
                return new FixedWindowAlgorithm();
            case Algorithm.SLIDING_LOG:
                return new SlidingWindowLogAlgorithm();
            case Algorithm.SLIDING_COUNT:
                return new SlidingWindowCountAlgorithm();
            default:
                throw new RateLimitError(
                    "ALGORITHM_ERROR",
                    `Unknown algorithm: ${this.config.algorithm}`
                );
        }
    }

    // method to help in resolve key
    private async resolvekey(req: TReq): Promise<string> {
        if(this.config.keyGenerator) {
            return this.config.keyGenerator(req);
        }
        // Default: extract IP from common request shapes
        return this.extractIP(req);
    }

    // method to resolve IP address
    private extractIP(req: TReq): string {
        const r = req as any;

        // req.ip — Fastify resolves proxy headers into this automatically
        // Express sets this from socket unless trust proxy enabled
        const reqIp = r?.ip;

        // If req.ip exists and is not a loopback — trust it
        // Fastify with trustProxy will have real IP here already
        if(reqIp && !this.isLoopBack(reqIp)) {
            return reqIp.split(",")[0].trim();
        }

        // Web Standard API (Hono, Cloudflare Workers, Deno)
        // Headers object has .get() method
        if(typeof r?.headers?.get === "function") {
            const forwarded = r?.headers?.get("x-forwarded-for");
            if(forwarded) {
                const ip = forwarded.split(",")[0].trim();
                if(ip && !this.isLoopBack(ip)) {
                    return ip;
                }
            }

            const realIP = r?.headers?.get("x-real-ip");
            if(realIP && !this.isLoopBack(realIP)) {
                return realIP;
            }

            // Cloudflare specific
            const cfIP = r?.headers?.get("cf-connecting-ip");
            if(cfIP && !this.isLoopBack(cfIP)) {
                return cfIP;
            }
        }

        // Fallback — check headers manually
        // Covers Express with proxy headers, raw Node, etc.
        const forwarded = r?.headers?.["x-forwarded-for"];
        if(forwarded) {
            const ip = typeof forwarded === "string"
            ? forwarded.split(",")[0]?.trim()
            : Array.isArray(forwarded)
                ? forwarded[0].split(",")[0].trim()
                : null;
            if(ip && !this.isLoopBack(ip)) {
                return ip;
            }
        }

        const realIP = r?.headers?.["x-real-ip"];
        if(realIP && !this.isLoopBack(realIP)) {
            return realIP;
        }

        // Last resort — whatever req.ip is even if loopback
        return (
            reqIp ||
            r?.socket?.remoteAddress ||
            r?.connection?.remoteAddress ||
            "unknown"
        ).split(",")[0].trim();
    }   

    private isLoopBack(ip: string): boolean {
        return (
            ip === "127.0.0.1"     ||
            ip === "::1"           ||
            ip === "localhost"     ||
            ip.startsWith("127.") ||
            ip === "::ffff:127.0.0.1"
        );
    }

    // method to build context
    private buildContext(key: string, req: TReq, now: number, weight: number): RateLimitContext {
        const r = req as any;
        return {
            key,
            ip: this.extractIP(req),
            path: r?.path ?? r?.url ?? "unknown",
            method: r?.method ?? "unknown",
            timestamp: now,
            weight,
            userId: r?.userId,
            route: r?.route ?? r?.routeId
        };
    }

    /**
     * Executes registered plugins for a given lifecycle hook.
     *
     * Supported hooks:
     * - onRequestStart
     * - onRequestEnd
     * - onError
     *
     * Plugin errors are caught and logged to prevent crashing the limiter.
     *
     * @internal
    */
    private async runPlugins(
        hook: "onRequestStart" | "onRequestEnd" | "onError",
        ctx: RateLimitContext,
        result?: RateLimitResult,
        error?: Error
    ): Promise<void> {
        if(!this.config.plugins?.length) {
            return;
        }

        for(const plugin of this.config.plugins) {
            // Skip disable plugins
            if(plugin.enabled === false) {
                continue;
            }

            try {
                const pluginName = plugin.name ?? "unknown-plugin";

                if(hook === "onRequestStart") {
                    await plugin.onRequestStart?.(ctx);
                } else if(hook === "onRequestEnd" && result) {
                    await plugin.onRequestEnd?.(ctx, result);
                } else if(hook === "onError" && error) {
                    await plugin.onError?.(error, ctx);
                }
            } catch(pluginErr) {
                // Plugin errors must never crash the limiter
                console.error(`Plugin "${plugin.name}" threw on ${hook}:`, pluginErr);
            }
        }
    }

    // method for error handling
    private async handleError(
        err: unknown, 
        req: TReq,
        res: unknown, 
        now: number,
        ctx?: RateLimitContext
    ): Promise<RateLimitResult> {
        const error = err instanceof Error ? err : new RateLimitError("INTERNAL_ERROR", String(err));

        // Notify user's error callback — wrap so it can't crash us
        try {
            this.config.onError?.(error as RateLimitError, req, res);
        } catch(callbackErr) {
            console.error("OnError callback threw:", callbackErr);
        }

        // Notify plugins — only if context exists
        if(ctx) {
            await this.runPlugins("onError", ctx, undefined, error);
        }

        // failOpen = true by default — allow on error
        if(this.config.failOpen !== false) {
            return this.buildFailedOpenResult(now);
        }

        throw error;
    }

    // method to build skip result when skip is true
    private buildSkipResult(now: number): RateLimitResult {
        return {
            allowed: true,
            remaining: this.config.limit,
            limit: this.config.limit,
            resetTime: now + this.config.windowMs
        };
    }

    // method to build result when failOpen is true
    private buildFailedOpenResult(now: number): RateLimitResult {
        return {
            allowed: true,
            remaining: -1, // signals "unknown — store was unavailable"
            limit: this.config.limit,
            resetTime: now + this.config.windowMs,
        };
    }

    /**
     * Resets rate limit state for a given request.
     *
     * Resolves the request key using the configured key generator
     * and removes its state from the store.
     *
     * @param req - Incoming request object
    */
    public async reset(req: TReq): Promise<void> {
        const key = await this.resolvekey(req);
        await this.config.store.delete(key);
    }

    /**
     * Resets rate limit state for a specific key.
     *
     * @param key - Unique rate limit key
    */
    public async resetKey(key: string): Promise<void> {
        return await this.config.store.delete(key);
    }

    /**
     * Returns the current rate limiter configuration.
     *
     * Useful for middleware adapters and debugging.
     *
     * @returns Readonly rate limit configuration
    */
    public getConfig(): Readonly<RateLimitConfig<TReq>> {
        return this.config;
    }
}