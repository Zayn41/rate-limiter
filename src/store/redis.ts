import type { RateLimitState } from "../types/state";
import type { RateLimitStore } from "../types/store";
import type { RateLimitResult } from "../types/result";
import { RateLimitError } from "../types/error";
import { Redis } from "ioredis";
import { 
    FIXED_WINDOW_SCRIPT, 
    TOKEN_BUCKET_SCRIPT, 
    SLIDING_LOG_SCRIPT, 
    SLIDING_COUNT_SCRIPT 
} from "./lua";

export interface RedisStoreOptions {
    client?: Redis;
    url?: string;
    port?: number;
    host?: string;
    password?: string;
    prefix?: string;
}

type LuaResult = [number, number, number, number, number];

/**
 * Redis-backed implementation of a rate limit store.
 *
 * This store uses Redis for persistence and Lua scripts for atomic,
 * concurrency-safe rate limiting operations.
 *
 * ⚡ Performance:
 * - Uses `EVALSHA` with script caching to reduce network overhead
 * - Falls back to `EVAL` automatically on `NOSCRIPT`
 *
 * 🔒 Concurrency:
 * - All rate limit operations are executed inside Redis via Lua
 * - Ensures atomicity (no race conditions under high load)
 *
 * 🧠 Supported algorithms:
 * - token-bucket
 * - fixed-window
 * - sliding-window-log
 * - sliding-window-count
 *
 * 🗂 Key namespacing:
 * - All keys are prefixed (default: "rl:") to avoid collisions
 */
export class RedisStore implements RateLimitStore {
    /** Store identifier */
    public readonly name = "RedisStore"; 

    /** Underlying Redis client instance */
    private readonly client: Redis;

    /** Key prefix used for namespacing */
    private readonly prefix: string;

    /**
     * Cache of Lua script SHA hashes.
     *
     * Prevents reloading scripts on every execution and enables fast
     * `EVALSHA` calls.
     */
    private shaCache = new Map<string, string>();

    /**
     * Creates a new RedisStore instance.
     *
     * @param options - Redis connection configuration
     * @param options.client - Existing Redis client instance
     * @param options.url - Redis connection URL
     * @param options.host - Redis host (default: 127.0.0.1)
     * @param options.port - Redis port (default: 6379)
     * @param options.password - Redis password
     * @param options.prefix - Key prefix (default: "rl:")
     */
    constructor(options: RedisStoreOptions = {}) {
        this.prefix = options.prefix ?? "rl:";
        this.client = this.initConnection(options);
    }

    /**
     * Initializes a Redis connection.
     *
     * - Uses provided client if available
     * - Supports URL or host/port config
     * - Includes retry strategy for transient failures
     *
     * @private
    */
    private initConnection(options: RedisStoreOptions): Redis {
        if(options.client) {
            return options.client;
        }

        let client: Redis;

        if(options.url) {
            client = new Redis(options.url);
        } else {
            client = new Redis({
                host: options.host ?? "127.0.0.1",
                port: Number(options.port) ?? 6379,
                password: options.password,
                retryStrategy(times) {
                    if(times > 3) {
                        return null;
                    }

                    return Math.min(times * 200, 2000);
                },
            });
        }

        client.on("error", (error) => {
            console.error("RedisStore connection error:", error.message);
        });

        return client;
    }

    /**
     * Sends a PING command to verify Redis availability.
     *
     * @returns true if Redis responds with "PONG", otherwise false
    */
    public async ping(): Promise<boolean> {
        try {
            const result = await this.client.ping();
            return result === "PONG";
        } catch {
            return false;
        }
    }

    /**
     * Waits until Redis connection is ready.
     *
     * Resolves immediately if already connected.
     *
     * @returns Promise that resolves when Redis is ready
    */
    public async connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            if(this.client.status === "ready") {
                resolve();
                return;
            }

            this.client.once("ready", resolve);
            this.client.once("error", reject);
        });
    }

    /**
     * Prefixes a key with the configured namespace.
     *
     * @param key - Raw key
     * @returns Prefixed Redis key
     * @private
    */
    private prefixKey(key: string): string {
        return `${this.prefix}${key}`;
    }

    /**
     * Retrieves stored rate limit state.
     *
     * @param key - Rate limit key
     * @returns Parsed state or null if not found
     * @throws {RateLimitError} If stored JSON is invalid
    */
    public async get(key: string): Promise<RateLimitState | null> {
        const raw = await this.client.get(this.prefixKey(key));
        if(!raw) {
            return null;
        }

        try {
            return JSON.parse(raw) as RateLimitState;
        } catch {
            throw new RateLimitError(
                "STORE_ERROR", 
                `Failed to parse state for key: ${key}`
            );
        }
    }

    /**
     * Stores rate limit state with TTL.
     *
     * @param key - Rate limit key
     * @param value - State object
     * @param ttl - Time to live in milliseconds
     * @throws {RateLimitError} If TTL is invalid (<= 0)
    */
    public async set(key: string, value: RateLimitState, ttl: number): Promise<void> {
        if(ttl <= 0) {
            throw new RateLimitError("INVALID_CONFIG", `TTL must be > 0, got ${ttl}`);
        }

        await this.client.set(
            this.prefixKey(key),
            JSON.stringify(value),
            "PX",
            ttl
        );
    }

    /**
     * Checks if a key exists in Redis.
     *
     * @param key - Rate limit key
     * @returns true if key exists
    */
    public async has(key: string): Promise<boolean> {
        const exists = await this.client.exists(this.prefixKey(key));
        return exists === 1;
    }
    
    /**
     * Deletes a key from Redis.
     *
     * @param key - Rate limit key
    */
    public async delete(key: string): Promise<void> {
        await this.client.del(this.prefixKey(key));
    }

    /**
     * Executes a rate limiting algorithm using Lua scripts.
     *
     * ⚡ Execution flow:
     * 1. Resolve script for algorithm
     * 2. Load and cache SHA (once)
     * 3. Execute via `EVALSHA`
     * 4. Fallback to `EVAL` if script missing (NOSCRIPT)
     *
     * 🔒 Guarantees:
     * - Atomic execution inside Redis
     * - Safe under high concurrency
     *
     * @param key - Rate limit key
     * @param args - Arguments:
     *   [algorithm, limit, windowMs, weight, now]
     *
     * @returns Parsed rate limit result
    */
    public async execute(key: string, args: unknown[]): Promise<RateLimitResult> {
        const [algorithmName, ...scriptArgs] = args as [string, ...number[]];

        // Select correct script
        const script = this.selectScript(algorithmName);
        const strArgs = scriptArgs.map(String);

        // Try evalsha first — faster, less bandwidth
        const sha = await this.getScriptSha(algorithmName, script);

        let raw: LuaResult;

        try {
            raw = await this.client.evalsha(
                sha, // run specific sha script
                1, // number of keys
                this.prefixKey(key), // KEYS[1],
                ...strArgs
            ) as LuaResult;
        } catch(err: any) {
            // NOSCRIPT = script not in Redis cache — fall back to eval
            if(err?.message?.includes("NOSCRIPT")) {
                // Run Lua script automatically
                raw = await this.client.eval(
                    script, // run specific script
                    1, // number of keys
                    this.prefixKey(key), // KEYS[1]
                    ...strArgs
                ) as LuaResult;
            } else {
                throw err;
            }
        }

        // Parse result array from Lua
        return this.parseResult(raw, key);
    }

    /**
     * Loads and caches Lua script SHA for fast execution.
     *
     * Uses Redis `SCRIPT LOAD` and stores SHA in memory.
     *
     * @param name - Algorithm name
     * @param script - Lua script content
     * @returns SHA hash of the script
     * @private
    */
    private async getScriptSha(name: string, script: string): Promise<string> {
        // Check if script already exist in cache map
        if(this.shaCache.has(name)) {
            return this.shaCache.get(name)!;
        }

        // Script Load sends script to Redis and return SHA
        const sha = await this.client.script("LOAD", script) as string;
        this.shaCache.set(name, sha);
        return sha;
    }

    /**
     * Selects the correct Lua script for a given algorithm.
     *
     * @param algorithm - Algorithm identifier
     * @returns Lua script string
     * @throws {RateLimitError} If algorithm is unsupported
     * @private
    */
    private selectScript(algorithm: string): string {
        switch(algorithm) {
            case "token-bucket":
                return TOKEN_BUCKET_SCRIPT;
            case "fixed-window":
                return FIXED_WINDOW_SCRIPT;
            case "sliding-window-log":
                return SLIDING_LOG_SCRIPT;
            case "sliding-window-count":
                return SLIDING_COUNT_SCRIPT;
            default:
                throw new RateLimitError(
                    "ALGORITHM_ERROR",
                    `No Lua script for algorithm: ${algorithm}`
                );
        }
    }

    /**
     * Parses Lua script result into structured response.
     *
     * @param raw - Lua result tuple:
     *   [allowed, remaining, limit, resetTime, retryAfter]
     * @param key - Rate limit key
     * @returns Structured RateLimitResult
     * @private
    */
    private parseResult(raw: LuaResult, key: string): RateLimitResult {
        const [allowed, remaining, limit, resetTime, retryAfter] = raw;

        return {
            allowed:    allowed === 1,
            remaining:  remaining,
            limit:      limit,
            resetTime:  resetTime,
            key,
            ...(retryAfter > 0 ? { retryAfter } : {})
        };
    }

    /**
     * Deletes all keys with the configured prefix.
     *
     * ⚠️ Warning:
     * Uses `KEYS` command which can block Redis in large datasets.
     * Suitable for testing or controlled environments only.
    */
    public async clear(): Promise<void> {
        const keys = await this.client.keys(`${this.prefix}*`)
        if(keys.length > 0) {
            await this.client.del(...keys);
        }
    }

    /**
     * Current Redis connection status.
     *
     * Possible values:
     * - "connecting"
     * - "ready"
     * - "end"
     *
     * @returns Connection status
    */
    public get status(): string {
        return this.client.status;
    }
    
    /**
     * Forcefully closes the Redis connection.
     *
     * - Does not wait for pending commands
     * - Safe for failure scenarios
    */
    public disconnect(): void {
        try {
            this.client.disconnect();
        } catch {
            // Already disconnected — ignore
        }
    }
    
    /**
     * Gracefully shuts down Redis connection.
     *
     * - Waits for pending commands
     * - Sends QUIT command
     *
     * ⚠️ May throw if connection is already closed.
    */
    public async shutdown(): Promise<void> {
        await this.client.quit();
    }
}