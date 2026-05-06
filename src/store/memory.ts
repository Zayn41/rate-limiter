import type { RateLimitState } from "../types/state";
import type { RateLimitStore } from "../types/store";
import { RateLimitError } from "../types/error";

/**
 * Linked list node for LRU cache tracking.
 * 
 * @private
 * @property key - The cache key this node represents
 * @property prev - Reference to previous node (more recently used)
 * @property next - Reference to next node (less recently used)
 */
interface LRUNode {
    key: string;
    prev: LRUNode | null;
    next: LRUNode | null;
}

/**
 * In-memory implementation of RateLimitStore with LRU (Least Recently Used) eviction.
 * 
 * Uses a combination of HashMap and Doubly-Linked List to achieve O(1) operations:
 * - O(1) get/set/delete
 * - O(1) LRU eviction
 * - O(1) access tracking via moveToFront
 * 
 * Features:
 * - **TTL-based automatic expiration**: Entries expire after specified TTL
 * - **LRU eviction**: When max capacity is reached, least recently used entry is removed
 * - **Periodic cleanup**: Background interval removes expired entries
 * - **Cross-runtime support**: Works in Node.js, Bun, Deno
 * - **Memory efficient**: Bounded by maxEntries, prevents unbounded growth
 * 
 * Architecture:
 * ```
 * HashMap (O(1) lookup)          Doubly-Linked List (O(1) eviction)
 * ┌─────────────┐                ┌──────────────────────────────┐
 * │ "user:123"  │───────┐        │ [HEAD] ↔ [Most Recent] ↔ ... │
 * │ "user:456"  │──┐    │        │                    ... ↔ [Least Recent] │
 * │ "user:789"  │  │    │        │                         ↔ [TAIL] │
 * └─────────────┘  │    └──────→ └──────────────────────────────┘
 *                  └─────────────→ (tail.prev is evicted next)
 * ```
 * 
 * @example
 * ```typescript
 * // Create store with 30s cleanup interval and 10k max entries
 * const store = new MemoryStore(30_000, 10_000);
 * 
 * // Set a rate limit state
 * await store.set("user:123", state, 60_000);
 * 
 * // Get it back (O(1), updates LRU)
 * const retrieved = await store.get("user:123");
 * 
 * // Check without updating LRU
 * const exists = await store.has("user:123");
 * 
 * // Cleanup when done
 * store.shutdown();
 * ```
 */
export class MemoryStore implements RateLimitStore {
    public readonly name = "MemoryStore"; 
    // public readonly execute = undefined;

    /**
     * Map storing the actual rate limit state with expiration times.
     * Combined with nodeMap for O(1) operations.
     * 
     * @private
     */
    private cache = new Map<string, { state: RateLimitState, expiresAt: number }>(); 

    /**
     * Map for O(1) lookup of LRU nodes.
     * Each key maps to its corresponding linked list node.
     * 
     * @private
     */

    private nodeMap = new Map<string, LRUNode>();

    /**
     * Sentinel head node (most recently used direction).
     * Points to the most recently used entry.
     * 
     * @private
     */
    private head: LRUNode;

    /**
     * Sentinel tail node (least recently used direction).
     * The node just before tail (tail.prev) is the LRU entry.
     * 
     * @private
     */
    private tail: LRUNode;

    /**
     * Interval ID for periodic cleanup of expired entries.
     * Uses cross-runtime safe type (works in Node.js, Bun, Deno).
     * 
     * @private
     */
    private interval?: ReturnType<typeof setInterval>; // cross-runtime safe (works in Node, Bun, Deno)  

    /**
     * Maximum number of entries before LRU eviction is triggered.
     * Prevents unbounded memory growth.
     * 
     * @private
     */
    private readonly maxEntries: number; 

    /**
     * Creates a new MemoryStore instance with LRU eviction policy.
     * 
     * @param cleanupIntervalMs - How often to remove expired entries (default: 60,000ms = 1 minute)
     * @param maxEntries - Maximum entries before LRU eviction (default: 10,000)
     * 
     * @remarks
     * - Set `cleanupIntervalMs` higher for less frequent cleanup (saves CPU)
     * - Set `cleanupIntervalMs` lower for faster expiration (uses more CPU)
     * - Set `maxEntries` based on expected concurrent users
     * - The interval uses `unref()` to not keep Node.js process alive
     * 
     * @example
     * ```typescript
     * // Default: cleanup every 60s, max 10k entries
     * const store = new MemoryStore();
     * 
     * // Aggressive cleanup: every 10s, max 5k entries
     * const store = new MemoryStore(10_000, 5_000);
     * 
     * // Lazy cleanup: every 5 minutes, max 100k entries
     * const store = new MemoryStore(300_000, 100_000);
     * ```
     */
    constructor(private readonly cleanupIntervalMs: number = 60_000, maxEntries = 10_000) {
        this.maxEntries = maxEntries;

        // Initialize sentinel nodes
        this.head = { key: "", prev: null, next: null };
        this.tail = { key: "", prev: null,  next: null };

        // Link sentinels
        this.head.next = this.tail;
        this.tail.prev = this.head;

        // Start cleanp interval
        this.interval = setInterval(() => this.cleanup(), cleanupIntervalMs);

        // Prevent interval from keeping Node.js process alive
        if(this.interval && typeof this.interval !== "number" && "unref" in this.interval) {
           (this.interval as NodeJS.Timeout).unref();
        }
    }

    /**
     * Retrieves the rate limit state for a given key.
     * 
     * **Important**: This method updates the LRU access time.
     * The retrieved entry is moved to "most recently used" position.
     * 
     * @param key - The key to retrieve (e.g., "user:123", "ip:192.168.1.1")
     * @returns The RateLimitState if found and not expired, null otherwise
     * @throws Never throws - always returns null on error
     * 
     * Time Complexity: O(1)
     * 
     * @remarks
     * - Expired entries are automatically deleted during get()
     * - Use `has()` instead if you want to check without updating LRU
     * - Safe to call repeatedly for the same key
     * 
     * @example
     * ```typescript
     * const state = await store.get("user:123");
     * if (state) {
     *   console.log(`Token count: ${state.data.tokens}`);
     * } else {
     *   console.log("No state found or expired");
     * }
     * ```
     */
    public async get(key: string): Promise<RateLimitState | null> {
        const entry = this.cache.get(key);
        if(!entry) {
            return null;
        }

        const now = Date.now()
        if(now > entry.expiresAt) {
            this.removeKey(key);
            return null;
        }

        // Update access time for LRU tracking
        this.moveToFront(key);
        return entry.state;
    }

    /**
     * Checks if a key exists and is not expired.
     * 
     * **Important**: This method does NOT update LRU access time.
     * Use this for read-only existence checks.
     * 
     * @param key - The key to check
     * @returns true if key exists and is not expired, false otherwise
     * @throws Never throws
     * 
     * Time Complexity: O(1)
     * 
     * @remarks
     * - Expired entries are automatically deleted during has()
     * - Does NOT count as an "access" for LRU purposes
     * - Use `get()` if you want to update LRU
     * 
     * @example
     * ```typescript
     * if (await store.has("user:123")) {
     *   console.log("User has active rate limit state");
     * }
     * ```
     */
    public async has(key: string): Promise<boolean> {
        const entry = this.cache.get(key);
        if(!entry) {
            return false;
        }

        const now = Date.now();
        if(now > entry.expiresAt) {
            this.removeKey(key);
            return false;
        }

        return true;
    }

    /**
     * Stores a rate limit state with TTL expiration.
     * 
     * If the key already exists, its value and TTL are updated and moved to "most recently used".
     * If capacity is reached, the least recently used entry is evicted.
     * 
     * @param key - Unique identifier (e.g., "user:123", "ip:192.168.1.1")
     * @param value - The RateLimitState to store (state object from algorithm)
     * @param ttl - Time-to-live in milliseconds (must be > 0)
     * @throws {RateLimitError} If ttl <= 0
     * 
     * Time Complexity: O(1)
     * 
     * @remarks
     * - TTL is required and must be positive
     * - Updating existing key does NOT count towards maxEntries
     * - LRU eviction happens BEFORE insertion if at capacity
     * - All timestamps are in milliseconds since epoch
     * 
     * @example
     * ```typescript
     * const state = {
     *   type: "token",
     *   data: { tokens: 50, lastRefill: Date.now() },
     *   ttl: 60_000
     * };
     * 
     * // First time - new entry
     * await store.set("user:123", state, 60_000);
     * 
     * // Second time - updates existing
     * await store.set("user:123", newState, 60_000);
     * 
     * // TTL must be > 0
     * await store.set("user:123", state, 0);  // Throws!
     * ```
     */
    public async set(key: string, value: RateLimitState, ttl: number): Promise<void> {
        // ttl is negative or zero throw an error
        if(ttl <= 0) {
            throw new RateLimitError("INVALID_CONFIG", `TTL must be > 0, got ${ttl}`);
        }

        // Updating exisiting — move to front
        if(this.cache.has(key)) {
            this.cache.set(key, { state: value, expiresAt: Date.now() + ttl });
            this.moveToFront(key);
            return;
        }

        // New key — evict if at capacity
        if(this.cache.size >= this.maxEntries) {
            this.evictLRU();
        }

        this.cache.set(key, { state: value, expiresAt: Date.now() + ttl });

        this.addToFront(key);
    }

    /**
     * Deletes a key from the cache immediately.
     * 
     * If the key doesn't exist, this is a no-op (doesn't throw).
     * 
     * @param key - The key to delete
     * @throws Never throws
     * 
     * Time Complexity: O(1)
     * 
     * @remarks
     * - Safe to call multiple times for the same key
     * - Removes from both cache and LRU list
     * 
     * @example
     * ```typescript
     * await store.delete("user:123");
     * console.log(await store.has("user:123")); // false
     * ```
     */
    public async delete(key: string): Promise<void> {
        this.removeKey(key);
    }

    /**
     * Adds a new key to the front of the LRU list (most recently used).
     * 
     * @private
     * @param key - The key to add
     */
    private addToFront(key: string): void {
        const node: LRUNode = { key, prev: this.head, next: this.head.next };
        this.head.next!.prev = node;
        this.head.next = node;
        this.nodeMap.set(key, node);
    }

    /**
     * Moves an existing key to the front of the LRU list (most recently used).
     * Called every time a key is accessed via get().
     * 
     * @private
     * @param key - The key to move to front
     */
    private moveToFront(key: string): void {
        const node = this.nodeMap.get(key);
        if(!node) {
            return;
        }

        this.detach(node);
        node.prev = this.head;
        node.next = this.head.next;
        this.head.next!.prev = node;
        this.head.next = node;
    }

    /**
     * Removes a node from the doubly-linked list.
     * Fixes links between adjacent nodes.
     * 
     * @private
     * @param node - The node to detach
     */
    private detach(node: LRUNode): void {
        node.prev!.next = node.next;
        node.next!.prev = node.prev;
    }

    /**
     * Evicts the least recently used entry from the cache.
     * The LRU entry is always at tail.prev (just before sentinel tail).
     * 
     * This is called automatically when maxEntries capacity is reached.
     * 
     * @private
     * @returns The key of the evicted entry, or undefined if cache is empty
     * 
     * Time Complexity: O(1)
     * 
     * @remarks
     * - Always removes the entry just before the tail sentinel
     * - Never removes the sentinel nodes themselves
     * - Safe to call on empty cache
     */
    private evictLRU(): string | undefined {
        // tail.prev is the least recently used node
        const lruNode = this.tail.prev;
        // Check if node exist or it is a head
        if(!lruNode || lruNode == this.head) {
            return;
        }

        this.removeKey(lruNode.key);
    }

    /**
     * Completely removes a key from cache and LRU tracking.
     * 
     * @private
     * @param key - The key to remove
     */
    private removeKey(key: string): void {
        const node = this.nodeMap.get(key);

        if(node) {
            this.detach(node);
            this.nodeMap.delete(key);
        }

        this.cache.delete(key);
    }

    /**
     * Removes all expired entries from the cache.
     * Called automatically at cleanupIntervalMs intervals.
     * 
     * This runs in the background and helps reclaim memory without waiting
     * for LRU eviction.
     * 
     * @private
     * @returns The number of entries removed
     * 
     * Time Complexity: O(n) where n = number of entries
     * 
     * @remarks
     * - Iterates through all entries to find expired ones
     * - Safe to call frequently (no harm if nothing expired)
     * - Runs in background interval, not user-facing
     */
    private cleanup(): number {
        const now = Date.now();
        let evicted = 0;

        for(const [key, entry] of this.cache) {
            if(now > entry.expiresAt) {
                this.removeKey(key);
                evicted++;
            }
        }

        return evicted;
    }

    /**
     * Gets the current number of entries in the cache.
     * 
     * @returns The count of active entries (not expired)
     * 
     * Time Complexity: O(1)
     * 
     * @remarks
     * - Does not count expired entries (they are cleaned up periodically)
     * - Useful for monitoring cache size
     * 
     * @example
     * ```typescript
     * console.log(`Cache size: ${store.size}`);
     * ```
     */
    public get size(): number {
        return this.cache.size;
    }

    /**
     * Clears all entries from the cache immediately.
     * 
     * Useful for testing or resetting the store.
     * 
     * Time Complexity: O(n) where n = number of entries
     * 
     * @remarks
     * - Removes all entries, even if not expired
     * - Does not stop the cleanup interval
     * - Cache is ready to use immediately after
     * 
     * @example
     * ```typescript
     * store.clear();
     * console.log(store.size); // 0
     * ```
     */
    public clear(): void {
        this.cache.clear();
        this.nodeMap.clear();
        this.head.next = this.tail;
        this.tail.prev = this.head;
    }

    /**
     * Shuts down the store and stops the cleanup interval.
     * 
     * Call this when you no longer need the store to prevent background
     * interval from running.
     * 
     * @remarks
     * - Required when shutting down your rate limiter
     * - Does not clear entries (they remain in memory)
     * - Safe to call multiple times
     * - After shutdown, you can no longer use get/set/delete
     * 
     * @example
     * ```typescript
     * const store = new MemoryStore();
     * // ... use store ...
     * await store.shutdown();
     * console.log("Store closed");
     * ```
     */
    public shutdown(): void {
        if(this.interval) {
            clearInterval(this.interval);
        }
    }
}       