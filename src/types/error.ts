/**
 * Standard error codes used by the rate limiter.
 * 
 * These codes help identify the source of failure
 * and allow consumers to handle errors programmatically.
 */
export type RateLimitErrorCode =
  | "STORE_ERROR"
  | "INVALID_CONFIG"
  | "INVALID_STORE"
  | "ALGORITHM_ERROR"
  | "KEY_GENERATION_ERROR"
  | "INTERNAL_ERROR";

/**
 * Custom error class for rate limiter failures.
 * 
 * Extends the native Error object with:
 * - `code` for structured error handling
 * - `meta` for additional debugging context
 * 
 * @example
 * ```ts
 * try {
 *   await limiter.consume(req);
 * } catch (err) {
 *   if (err instanceof RateLimitError) {
 *     if (err.code === "INVALID_CONFIG") {
 *       console.error("Config issue:", err.meta);
 *     }
 *   }
 * }
 * ```
 */
export class RateLimitError extends Error {
    /**
     * Machine-readable error code.
     */
    public readonly code: RateLimitErrorCode;

    /**
     * Optional metadata for debugging or logging.
     * 
     * Can include any additional context such as:
     * - key
     * - config values
     * - internal state
     */
    public readonly meta?: Record<string, unknown> | undefined;

    /**
     * Creates a new RateLimitError instance.
     * 
     * @param code - Error code identifying the failure type
     * @param message - Human-readable error message
     * @param meta - Optional additional context
     */
    constructor(code: RateLimitErrorCode, message: string, meta?: Record<string, unknown>) {
        super(message);
        this.code = code;
        this.meta = meta;
        this.name = "RateLimitError";

        // Cast Error constructor to any to access V8-specific captureStackTrace
        if((Error as any).captureStackTrace) {
            (Error as any).captureStackTrace(this, RateLimitError);
        }

        Object.setPrototypeOf(this, RateLimitError.prototype);

    }

    /**
     * Convert error to JSON for logging/API response.
     */
    public toJSON() {
        return {
            name: this.name,
            code: this.code,
            message: this.message,
            meta: this.meta
        }
    }

    /**
     * Get appropriate HTTP status code for this error.
     */
    public getStatusCode(): number {
        switch(this.code) {
            case "STORE_ERROR":
                return 503; // Service Unavailable
            case "INVALID_CONFIG":
                return 500; // Internal Server Error
            case "INVALID_STORE":
                return 500; // Invalid Store Error
            case "ALGORITHM_ERROR":
                return 500; // Invalid Algorithm Error
            case "KEY_GENERATION_ERROR":
                return 400; // Bad Request
            case "INTERNAL_ERROR":
                return 500; 
            default:
                return 500;
        }
    }
}