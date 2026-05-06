import { describe, expect, it, beforeAll, beforeEach, afterEach } from "vitest";
import { RedisStore } from "../../store/redis";
import { Algorithm } from "../../types/config";

const REDIS_URL = process.env.REDIS_URL;

/**
 * Integration tests for RedisStore using Lua scripts.
 *
 * Validates:
 * - Correct behavior of all rate limiting algorithms
 * - Atomic execution via Redis Lua (no race conditions)
 * - TTL expiration and reset behavior
 *
 * These tests require a running Redis instance.
 */
describe.skipIf(!REDIS_URL)("Lua Scripts Integration", () => {
    let store: RedisStore;

    beforeAll(async () => {
        const test = new RedisStore({ url: REDIS_URL! });
        const alive = await test.ping();
        await test.shutdown();
        if(!alive) {
            throw new Error("Redis not available");
        } 
    });

    beforeEach(async () => {
        store = new RedisStore({ url: REDIS_URL! });
        await store.clear();
    });

    afterEach(async () => {
        await store.clear();
        await store.shutdown();
    });

    /**
     * Helper to build arguments passed to Redis Lua scripts.
     *
     * @param algorithm - Algorithm name
     * @param limit - Max requests allowed
     * @param windowMs - Time window in ms
     * @param weight - Request weight
     * @returns Argument array for RedisStore.execute()
    */
    const args = (algorithm: string, limit = 5, windowMs = 10_000, weight = 1) => [
        algorithm, limit, windowMs, weight, Date.now()
    ];

    /**
     * Runs the same behavioral tests across all algorithms.
     *
     * Ensures consistent contract:
     * - Requests are allowed under limit
     * - Requests are blocked after limit
     * - Response shape is correct
    */
    describe.each([
        ["Token Bucket", Algorithm.TOKEN],
        ["Fixed Window", Algorithm.FIXED],
        ["Sliding Window Log", Algorithm.SLIDING_LOG],
        ["Sliding Window Count", Algorithm.SLIDING_COUNT],
    ])("%s", (name, algorithm) => {
        it("allow requests under limit", async () => {
            for(let i = 0; i < 5; i++) {
                const result = await store.execute(`test:${algorithm}`, args(algorithm));
                expect(result.allowed).toBe(true);
            };
        });

        it("denies when limit exceed", async () => {
            for(let i = 0; i < 5; i++) {
                await store.execute(`test:${algorithm}`, args(algorithm));
            }

            const result = await store.execute(`test:${algorithm}`, args(algorithm));
            expect(result.allowed).toBe(false);
        });

        it("result has correct shape", async () => {
            const result = await store.execute(`test:${algorithm}`, args(algorithm));
            expect(result).toHaveProperty("allowed");
            expect(result).toHaveProperty("remaining");
            expect(result).toHaveProperty("limit");
            expect(result).toHaveProperty("resetTime");
        });

        it("remaining decrements correctly", async () => {
            for(let i = 0; i < 5; i++) {
                const result = await store.execute(`test:${algorithm}`, args(algorithm));
                expect(result.remaining).toBe(5 - i - 1);
            }
        });

        it("retryAfter defined when denied", async () => {
            for(let i = 0; i < 5; i++) {
                await store.execute(`test:${algorithm}`, args(algorithm));
            }

            const result = await store.execute(`test:${algorithm}`, args(algorithm));
            expect(result.allowed).toBe(false);
            expect(result.retryAfter).toBeDefined();
            expect(result.retryAfter).toBeGreaterThan(0);
        });

        it("different keys are independent", async () => {
            for(let i = 0; i < 5; i++) {
                await store.execute(`key1:${algorithm}`, args(algorithm));
            }

            const result = await store.execute(`key2:${algorithm}`, args(algorithm));
            expect(result.allowed).toBe(true);
        });
    });

    /**
     * Ensures atomicity under concurrent requests.
     *
     * Without Lua scripts, race conditions could allow
     * more requests than the configured limit.
     *
     * These tests verify that Redis + Lua guarantees correctness.
    */
    describe("Atomicity under concurrency", () => {
        it("concurrent requests do not exceed limit", async () => {
            const limit = 5;
            const key = "concurrent:key";
            const results = await Promise.all(
                Array.from({ length: 20 }, () => 
                    store.execute(key, args(Algorithm.FIXED, limit))
                ),
            );

            const allowed = results.filter(res => res.allowed).length;
            expect(allowed).toBeLessThanOrEqual(limit);
        });

        it("token bucket concurrent requests stays within limit", async () => {
            const limit = 5;
            const key = "concurrent:key";
            const results = await Promise.all(
                Array.from({ length: 20 }, () =>
                    store.execute(key, args(Algorithm.TOKEN, limit)) 
                ),
            );

            const allowed = results.filter(res => res.allowed).length;
            expect(allowed).toBeLessThanOrEqual(limit);
        });
    });

    /**
     * Verifies that rate limits reset correctly after TTL expires.
     *
     * Ensures that:
     * - Requests are blocked once limit is reached
     * - After window expiration, requests are allowed again
    */
    describe("TTL expiry", () => {
        it("resets after window expires", async () => {
            const key = "ttl:test";

            for(let i = 0; i < 5; i++) {
                await store.execute(key, [Algorithm.FIXED, 5, 500, 1, Date.now()]);
            }

            expect(
                (await store.execute(key, [Algorithm.FIXED, 5, 500, 1, Date.now()])).allowed
            ).toBe(false);

            // Wait for window to expire
            await new Promise(r => setTimeout(r, 600));

            expect(
                (await store.execute(key, [Algorithm.FIXED, 5, 500, 1, Date.now()])).allowed
            ).toBe(true);
        });
    });
});