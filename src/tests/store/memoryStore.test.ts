import { describe, it, afterEach, beforeEach, expect } from "vitest";
import { advanceTime, resetTime, setupMockTime } from "../utils/mockTime";
import { MemoryStore } from "../../store/memory";

const BASE_TIME = 1_700_000_000_000;
const TTL = 10_000;

const makeState = (type = "token"): any => ({
    type,
    data: { tokens: 5, lastRefill: BASE_TIME },
    ttl: 10_000
});

/**
 * Unit tests for MemoryStore implementation.
 *
 * Covers:
 * - Core key-value operations (get/set/has/delete)
 * - TTL-based expiration behavior
 * - Lazy deletion on access
 * - LRU eviction strategy under capacity limits
 * - Background cleanup interval
 * - Interface compliance with RateLimitStore
 *
 * Uses mocked time utilities to simulate expiration and cleanup.
*/
describe("Memory Store", () => {
    let store: MemoryStore;

    beforeEach(() => {
        setupMockTime(BASE_TIME);
        store = new MemoryStore();
    });

    afterEach(() => {
        store.clear();
        store.shutdown();
        resetTime();
    });

    /**
     * Validates fundamental key-value store behavior.
     *
     * Ensures:
     * - Values can be stored and retrieved
     * - Missing keys return null
     * - has() reflects existence correctly
     * - delete() removes entries safely
     * - clear() resets the entire store
     * - size tracks number of active entries
     * - Overwrites replace existing values
    */
    describe("Basic operations", () => {
        it("stores and retrieves value", async () => {
            const state = makeState();
            await store.set("key", state, TTL);
            expect(await store.get("key")).toEqual(state);
        });

        it("returns null for missing key", async () => {
            expect(await store.get("nonexistent")).toBeNull();
        });

        it("has() returns true for existing key", async () => {
            const state = makeState();
            expect(await store.set("key", state, TTL));
            expect(await store.has("key")).toBe(true);
        });

        it("delete() removes a key", async () => {
            const state = makeState();
            await store.set("key", state, TTL);
            await store.delete("key");
            expect(await store.get("key")).toBeNull();
        });

        it("delete() on missing key does not throw", async () => {
            await expect(store.delete("nonexistent")).resolves.not.toThrow();
        });

        it("clear() removes all keys", async () => {
            const state1 = makeState();
            const state2 = makeState();
            await store.set("key1", state1, TTL);
            await store.set("key2", state2, TTL);
            store.clear();
            expect(await store.get("key1")).toBeNull();
            expect(await store.get("key2")).toBeNull();
            expect(store.size).toBe(0);
        });

        it("size reflects current entry count", async () => {
            expect(store.size).toBe(0);
            const state1 = makeState();
            await store.set("key1", state1, TTL);

            expect(store.size).toBe(1);

            const state2 = makeState();
            await store.set("key2", state2, TTL);

            expect(store.size).toBe(2);

            await store.delete("key1");

            expect(store.size).toBe(1);
        });

        it("overwriting a key updates value", async () => {
            const state1 = makeState("token");
            const state2 = makeState("fixed");
            await store.set("key", state1, TTL);
            await store.set("key", state2, TTL);
            expect(await store.get("key")).toEqual(state2);
        });    
    });

   /**
     * Tests TTL-based expiration logic.
     *
     * Ensures:
     * - Keys expire after TTL
     * - Keys remain accessible before TTL
     * - has() reflects expiration correctly
     * - Expired entries are lazily removed on access
     * - Invalid TTL values throw errors
     * - Different keys can have independent TTLs
    */
    describe("TTL and expiry", () => {
        it("returns null after TTL expires", async () => {
            const state = makeState();
            await store.set("key", state, 5_000);

            advanceTime(5001); // past TTL

            expect(await store.get("key")).toBeNull();
        });


        it("returns value before TTL expires", async () => {
            const state = makeState();
            await store.set("key", state, 5_000);

            advanceTime(4_999); // just before TTL
            expect(await store.get("key")).not.toBeNull();
        });

        it("has() returns false after TTL expires", async () => {
            const state = makeState();
            await store.set("key", state, 5_000);

            advanceTime(5_001); // past TTL
            expect(await store.has("key")).toBe(false);
        });

        it("expired key is removed from cache on get()", async () => {
            const state = makeState();
            await store.set("key", state, 5_000);

            advanceTime(5_001); // past TTL
            await store.get("key"); // triggers lazy delete
            expect(store.size).toBe(0);
        });

        it("expired key is removed from cache on has()", async () => {
            const state = makeState();
            await store.set("key", state, 5_000);

            advanceTime(5_001) // past TTL
            await store.has("key") // triggers lazy delete
            expect(store.size).toBe(0);
        });

        it("throws on TTL <= 0", async () => {
            await expect(
                store.set("key", makeState(), 0)
            ).rejects.toThrow()
        });

        it("throws on negative TTL", async () => {
            await expect(
                store.set("key", makeState(), -1)
            ).rejects.toThrow()
        });

        it("different keys can have different TTL'S", async () => {
            await store.set("short", makeState(), 1_000);
            await store.set("long", makeState(), TTL);

            advanceTime(1_001);

            expect(await store.get("short")).toBeNull();
            expect(await store.get("long")).not.toBeNull();
        });
    });

    /**
     * Verifies Least Recently Used (LRU) eviction policy.
     *
     * Ensures:
     * - Oldest unused entries are evicted when capacity is reached
     * - Recently accessed keys are retained
     * - Updating an existing key does not trigger eviction
     * - Store size never exceeds maxEntries limit
    */
    describe("LRU eviction", () => {
        it("evicts LRU entry when at capacity", async() => {
            const smallStore = new MemoryStore(60_000, 3); // max 3 entries

            await smallStore.set("a", makeState(), TTL);
            await smallStore.set("b", makeState(), TTL);
            await smallStore.set("c", makeState(), TTL);

            // Access "a" and "b" to make "a" most recently used
            await smallStore.get("a");
            await smallStore.get("b");

            // "c" is now LRU — adding "d" should evict "c"
            await smallStore.set("d", makeState(), TTL);

            expect(await smallStore.get("c")).toBeNull(); // evicted because of LRU
            expect(await smallStore.get("a")).not.toBeNull();
            expect(await smallStore.get("b")).not.toBeNull();
            expect(await smallStore.get("d")).not.toBeNull();

            smallStore.clear();
            smallStore.shutdown();
        });

        it("updating existing key does not evict", async () => {
            const smallStore = new MemoryStore(60_000, 2);

            await smallStore.set("a", makeState(), TTL);
            await smallStore.set("b", makeState(), TTL);

            // Update "a" — should not cause eviction
            await smallStore.set("a", makeState("fixed"), TTL);

            expect(smallStore.size).toBeLessThanOrEqual(2);
            expect(await smallStore.get("b")).not.toBeNull();

            smallStore.clear();
            smallStore.shutdown();
        });

        it("size never exceeds maxEntries", async () => {
            const smallStore = new MemoryStore(60_000, 5);

            for(let i = 0; i < 20; i++) {
                await smallStore.set(`key${i}`, makeState(), TTL);
            }

            expect(smallStore.size).toBeLessThanOrEqual(5);

            smallStore.clear();
            smallStore.shutdown();
        });
    });

    /**
     * Tests background cleanup mechanism.
     *
     * Ensures:
     * - Expired entries are automatically removed via interval
     * - Cleanup runs independently of read/write operations
     * - shutdown() safely stops the cleanup timer
    */
    describe("Cleanup", () => {
        it("cleanup removes expired entries automatically", async () => {
            // Use very short cleanup interval
            const fastStore = new MemoryStore(100, TTL);

            await fastStore.set("key1", makeState(), 500);
            await fastStore.set("key2", makeState(), 500);

            advanceTime(600); // expires entries
            advanceTime(100); // triggers cleanup interval

            expect(fastStore.size).toBe(0);

            fastStore.clear();
            fastStore.shutdown();
        });

        it("shutdown stops cleanup interval", () => {
            expect(() => store.shutdown()).not.toThrow();
            // calling shutdown twice should not throw
            expect(() => store.shutdown()).not.toThrow();
        });
    });

    /**
     * Ensures MemoryStore adheres to RateLimitStore interface.
     *
     * Validates:
     * - Required methods are implemented
     * - Store metadata (name) is correct
    */
    describe("Interface compliance", () => {
        it("has correct name", () => {
            expect(store.name).toBe("MemoryStore");
        });

        // it("execute undefined", () => {
        //     expect(store.execute).toBeUndefined()
        // })

        it("implements all required methods", () => {
            expect(typeof store.get).toBe("function");
            expect(typeof store.set).toBe("function");
            expect(typeof store.has).toBe("function");
            expect(typeof store.delete).toBe("function");
        });
    });
});