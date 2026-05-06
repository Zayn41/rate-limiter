import type { RateLimitState } from "./state";
import type { RateLimitResult } from "./result";

/**
    * Supported store types for configuration.
*/
export type StoreType = "memory" | "redis";

/**
    * Represents a storage backend for rate limiting.
    * 
    * Implementations can be in-memory, Redis, or any custom store.
    * 
    * Responsibilities:
    * - Persist rate limit state per key
    * - Handle TTL-based expiration
    * - Provide atomic operations if supported (e.g., Redis Lua via `execute`)
    * 
    * @example
    * ```ts
    * const store: RateLimitStore = new MemoryStore();
    * await store.set("user:123", state, 60_000);
    * const data = await store.get("user:123");
 * ```
*/
export interface RateLimitStore {
    /**
        * Name of the store implementation (e.g., "MemoryStore", "RedisStore").
    */
    name: string;

    /**
        * Retrieves the stored rate limit state for a given key.
        * 
        * @param key - Unique identifier (e.g., user ID, IP address)
        * @returns The stored state if present and not expired, otherwise null
    */
    get(key: string): Promise<RateLimitState | null>;

    /**
        * Stores the rate limit state with an optional TTL.
        * 
        * @param key - Unique identifier
        * @param value - The rate limit state to store
        * @param ttl - Time-to-live in milliseconds (optional but recommended)
    */
    set(key: string, value: RateLimitState, ttl?: number): Promise<void>;

    /**
        * Deletes a stored key and its associated state.
        * 
        * @param key - Unique identifier
    */
    delete(key: string): Promise<void>;

    /**
        * Optional optimized execution method (e.g., Redis Lua scripts).
        * 
        * This allows atomic operations to avoid race conditions in distributed systems.
        * 
        * Not supported by all stores (e.g., MemoryStore).
        * 
        * @param key - Unique identifier
        * @param args - Arguments required for the operation
        * @returns Computed rate limit result
    */
    execute?(key: string, args: unknown[]): Promise<RateLimitResult>;
}