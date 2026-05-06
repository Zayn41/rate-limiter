import type { RateLimitContext } from "./context";
import type { RateLimitResult } from "./result";

/**
 * Plugin interface for extending rate limiter behavior.
 * 
 * Plugins allow hooking into the request lifecycle for:
 * - Logging
 * - Metrics (e.g., Prometheus)
 * - Tracing
 * - Debugging
 * 
 * All hooks are optional and can be async.
 */
export interface RateLimitPlugin {
    /**
     * Unique name of the plugin.
     */
    name: string;

    /**
     * Whether this plugin is currently active.
     * 
     * If set to `false`, all hooks for this plugin will be skipped.
     * Defaults to `true` when undefined.
     */
    enabled?: boolean;
    
    /**
     * Called before rate limiting logic is executed.
     * 
     * @param ctx - Request context containing metadata (key, IP, path, etc.)
     * 
     * @example
     * ```ts
     * onRequestStart(ctx) {
     *   console.log("Incoming request:", ctx.key);
     * }
     * ```
     */
    onRequestStart?: (ctx: RateLimitContext) => void | Promise<void>;

    /**
     * Called after rate limiting logic completes.
     * 
     * @param ctx - Request context
     * @param result - Result of rate limiting evaluation
     * 
     * @example
     * ```ts
     * onRequestEnd(ctx, result) {
     *   console.log("Allowed:", result.allowed);
     * }
     * ```
     */
    onRequestEnd?: (ctx: RateLimitContext, result: RateLimitResult) => void | Promise<void>;

    /**
     * Called when the rate limiter is shutting down.
     * 
     * Use this hook to clean up resources such as:
     * - closing connections (e.g., Redis)
     * - flushing metrics or logs
     * - stopping background tasks
     * 
     * This is typically invoked when the application is terminating
     * or when the rate limiter instance is explicitly disposed.
     */
    shutdown?: () => void | Promise<void>;

    /**
     * Called when an error occurs during rate limiting.
     * 
     * @param error - The error thrown
     * @param ctx - Request context
     * 
     * @example
     * ```ts
     * onError(error, ctx) {
     *   console.error("Rate limiter failed:", error);
     * }
     * ```
     */
    onError?: (error: Error, ctx: RateLimitContext) => void | Promise<void>;
}