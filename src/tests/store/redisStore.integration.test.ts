import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import { RedisStore } from "../../store/redis";
import dotenv from "dotenv";

dotenv.config();

const REDIS_URL = process.env.REDIS_URL;

/**
 * Integration tests for RedisStore using a real Redis instance.
 *
 * These tests validate:
 * - Actual Redis connectivity and behavior (no mocks)
 * - Data persistence and retrieval
 * - TTL expiration handled by Redis
 * - Prefix isolation between store instances
 * - Concurrent access safety
 *
 * ⚠️ Requires:
 * - REDIS_URL environment variable
 * - Running Redis instance (e.g. via Docker)
 *
 * Tests are skipped automatically if Redis is not configured.
*/
describe.skipIf(!REDIS_URL)("RedisStore Integration", () => {
    let store: RedisStore;

    beforeAll(async () => {
        // Verify Redis is actually reachable before running any tests
        const testStore = new RedisStore({ url: REDIS_URL! });
        const alive = await testStore.ping();
        await testStore.shutdown();
        if (!alive) throw new Error("Redis not reachable — start Docker first");
    });

    beforeEach(async () => {
        store = new RedisStore({ url: REDIS_URL! });
        await store.clear(); // clean slate for each test
    });

    afterEach(async () => {
        await store?.clear();
        await store?.shutdown();
    });

    /**
     * Verifies basic store metadata and connection health.
     *
     * Ensures:
     * - Store name is correct
     * - Redis connection is alive (ping)
     * - Client status reflects ready state
    */
    describe("Interface", () => {
        it("has correct name", () => {
            expect(store.name).toBe("RedisStore");
        });

        it("ping() returns true when connected", async () => {
            expect(await store.ping()).toBe(true);
        });

        it("status is ready after connection", () => {
            expect(store.status).toBe("ready");
        });
    });

    /**
     * Tests persistence and retrieval of data in Redis.
     *
     * Ensures:
     * - Values are stored and retrieved correctly
     * - Missing keys return null
     * - Existing keys can be overwritten
     * - TTL validation is enforced
     * - Key prefixing isolates data between store instances
    */
    describe("set() and get()", () => {
        it("stores and retrieves state", async () => {
            const state = {
                type: "token",
                data: { tokens: 5, lastRefill: Date.now() },
                ttl:  10_000
            };
            await store.set("test:key", state as any, 10_000);
            expect(await store.get("test:key")).toEqual(state);
        });

        it("returns null for missing key", async () => {
            expect(await store.get("nonexistent")).toBeNull();
        });

        it("overwrites existing key", async () => {
            const state1 = { type: "token", data: { tokens: 5 }, ttl: 10_000 };
            const state2 = { type: "token", data: { tokens: 3 }, ttl: 10_000 };
            await store.set("key", state1 as any, 10_000);
            await store.set("key", state2 as any, 10_000);
            expect(await store.get("key")).toEqual(state2);
        });

        it("throws on TTL <= 0", async () => {
            await expect(
                store.set("key", {} as any, 0)
            ).rejects.toThrow();
        });

        it("throws on negative TTL", async () => {
            await expect(
                store.set("key", {} as any, -1)
            ).rejects.toThrow();
        });

        it("uses key prefix correctly", async () => {
            const state = { type: "fixed", data: { count: 1 }, ttl: 10_000 };
            await store.set("user:123", state as any, 10_000);

            // Custom prefix store should not see this key
            const otherStore = new RedisStore({
                url:    REDIS_URL!,
                prefix: "other:"
            });
            expect(await otherStore.get("user:123")).toBeNull();
            await otherStore.shutdown();
        });
    });

    /**
     * Validates Redis-native TTL expiration behavior.
     *
     * Ensures:
     * - Keys expire automatically after TTL
     * - Keys remain accessible before expiration
     *
     * Note: Uses real time delays instead of mocked timers.
    */
    describe("TTL expiry", () => {
        it("entry expires after TTL", async () => {
            const state = { type: "token", data: { tokens: 5 }, ttl: 100 };
            await store.set("expiry:key", state as any, 100); // 100ms TTL

            // Wait for expiry
            await new Promise(r => setTimeout(r, 200));

            expect(await store.get("expiry:key")).toBeNull();
        });

        it("entry exists before TTL expires", async () => {
            const state = { type: "token", data: { tokens: 5 }, ttl: 5000 };
            await store.set("live:key", state as any, 5_000);

            // Check immediately — should still exist
            expect(await store.get("live:key")).not.toBeNull();
        });
    });

    /**
     * Tests existence checks using Redis EXISTS command.
     *
     * Ensures:
     * - Correct detection of existing keys
     * - Missing keys return false
     * - Expired keys are not reported as existing
    */
    describe("has()", () => {
        it("returns true for existing key", async () => {
            await store.set("key", { type: "token", data: {}, ttl: 10_000 } as any, 10_000);
            expect(await store.has("key")).toBe(true);
        });

        it("returns false for missing key", async () => {
            expect(await store.has("nonexistent")).toBe(false);
        });

        it("returns false after TTL expires", async () => {
            await store.set("key", { type: "token", data: {}, ttl: 100 } as any, 100);
            await new Promise(r => setTimeout(r, 200));
            expect(await store.has("key")).toBe(false);
        });
    });

    /**
     * Verifies key deletion behavior.
     *
     * Ensures:
     * - Keys are removed correctly
     * - Deleting non-existent keys does not throw
    */
    describe("delete()", () => {
        it("removes existing key", async () => {
            await store.set("key", { type: "token", data: {}, ttl: 10_000 } as any, 10_000);
            await store.delete("key");
            expect(await store.get("key")).toBeNull();
        });

        it("does not throw on missing key", async () => {
            await expect(store.delete("nonexistent")).resolves.not.toThrow();
        });
    });

    /**
     * Tests bulk deletion of keys using prefix-based clearing.
     *
     * Ensures:
     * - All keys with current prefix are removed
     * - Keys from other prefixes remain untouched
    */
    describe("clear()", () => {
        it("removes all prefixed keys", async () => {
            await store.set("key1", { type: "token", data: {}, ttl: 10_000 } as any, 10_000);
            await store.set("key2", { type: "token", data: {}, ttl: 10_000 } as any, 10_000);

            await store.clear();

            expect(await store.get("key1")).toBeNull();
            expect(await store.get("key2")).toBeNull();
        });

        it("only removes keys with this store's prefix", async () => {
            // Set key with different prefix
            const otherStore = new RedisStore({
                url:    REDIS_URL!,
                prefix: "other:"
            });
            await otherStore.set(
                "key",
                { type: "token", data: {}, ttl: 10_000 } as any,
                10_000
            );

            // Clear this store — should not affect other prefix
            await store.clear();

            expect(await otherStore.get("key")).not.toBeNull();

            await otherStore.clear();
            await otherStore.shutdown();
        });
    });

    /**
     * Validates concurrent access behavior.
     *
     * Ensures:
     * - Multiple writes can occur in parallel without data loss
     * - Concurrent reads return consistent results
     *
     * Note: Redis handles concurrency internally, but this verifies usage correctness.
    */
    describe("Concurrent operations", () => {
        it("handles multiple concurrent sets", async () => {
            const state = { type: "token", data: { tokens: 5 }, ttl: 10_000 };

            // Fire 10 concurrent sets
            await Promise.all(
                Array.from({ length: 10 }, (_, i) =>
                    store.set(`key:${i}`, state as any, 10_000)
                )
            );

            // All should be stored
            for (let i = 0; i < 10; i++) {
                expect(await store.get(`key:${i}`)).toEqual(state);
            }
        });

        it("handles concurrent gets on same key", async () => {
            const state = { type: "fixed", data: { count: 1 }, ttl: 10_000 };
            await store.set("shared:key", state as any, 10_000);

            // Fire 10 concurrent gets
            const results = await Promise.all(
                Array.from({ length: 10 }, () => store.get("shared:key"))
            );

            // All should return same state
            results.forEach(r => expect(r).toEqual(state));
        });
    });

    /**
     * Tests graceful shutdown of Redis connection.
     *
     * Ensures:
     * - Connection can be closed without errors
     * - No resource leaks or unhandled rejections
    */
    describe("shutdown()", () => {
        it("closes connection gracefully", async () => {
            const tempStore = new RedisStore({ url: REDIS_URL! });
            await expect(tempStore.shutdown()).resolves.not.toThrow();
        });
    });
});