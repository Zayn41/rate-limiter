import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";

vi.mock("ioredis", () => {
    const mockClient = {
        eval:    vi.fn(),
        evalsha: vi.fn(),
        script:  vi.fn().mockResolvedValue("fakeSha123"), // ✅ returns SHA string
        get:     vi.fn(),
        set:     vi.fn(),
        del:     vi.fn(),
        exists:  vi.fn(),
        quit:    vi.fn(),
        ping:    vi.fn().mockResolvedValue("PONG"),
        on:      vi.fn(),
        once:    vi.fn(),
        keys:    vi.fn().mockResolvedValue([]),
        status:  "ready"
    };

    const MockRedis = vi.fn().mockImplementation(function () {
        return mockClient;
    });

    return { Redis: MockRedis, default: MockRedis };
});

import { RedisStore } from "../../store/redis";
import Redis from "ioredis";
import { Algorithm } from "../../types/config";

describe("RedisStore Lua execute()", () => {
    let store: RedisStore;
    let mockClient: any;

    const mockLuaResult = [1, 4, 5, 1700000060000, 0];

    beforeEach(() => {
        vi.clearAllMocks();
        store = new RedisStore({ host: "localhost" });
        const calls = (Redis as any).mock.results;
        mockClient  = calls[calls.length - 1].value;

        // Default — evalsha succeeds
        mockClient.script.mockResolvedValue("fakeSha123");
        mockClient.evalsha.mockResolvedValue(mockLuaResult);
    });

    // ─── selectScript ──────────────────────────────────────────
    describe("selectScripts", () => {
        it("selects token bucket script", async () => {
            await store.execute("key", [Algorithm.TOKEN, 5, 10000, 1, Date.now()]);

            expect(mockClient.script).toHaveBeenCalledWith(
                "LOAD",
                expect.stringContaining("refillRate")
            );
            expect(mockClient.evalsha).toHaveBeenCalledWith(
                "fakeSha123", 1,
                expect.any(String), expect.any(String),
                expect.any(String), expect.any(String), expect.any(String)
            );
        });

        it("selects fixed window script", async () => {
            await store.execute("key", [Algorithm.FIXED, 5, 10000, 1, Date.now()]);

            expect(mockClient.script).toHaveBeenCalledWith(
                "LOAD",
                expect.stringContaining("windowStart")
            );
            expect(mockClient.evalsha).toHaveBeenCalledWith(
                "fakeSha123", 1,
                expect.any(String), expect.any(String),
                expect.any(String), expect.any(String), expect.any(String)
            );
        });

        it("selects sliding window log script", async () => {
            await store.execute("key", [Algorithm.SLIDING_LOG, 5, 10000, 1, Date.now()]);

            expect(mockClient.script).toHaveBeenCalledWith(
                "LOAD",
                expect.stringContaining("ZREMRANGEBYSCORE")
            );
            expect(mockClient.evalsha).toHaveBeenCalledWith(
                "fakeSha123", 1,
                expect.any(String), expect.any(String),
                expect.any(String), expect.any(String), expect.any(String)
            );
        });

        it("selects sliding window count script", async () => {
            await store.execute("key", [Algorithm.SLIDING_COUNT, 5, 10000, 1, Date.now()]);

            expect(mockClient.script).toHaveBeenCalledWith(
                "LOAD",
                expect.stringContaining("currentCount")
            );
            expect(mockClient.evalsha).toHaveBeenCalledWith(
                "fakeSha123", 1,
                expect.any(String), expect.any(String),
                expect.any(String), expect.any(String), expect.any(String)
            );
        });

        it("throws on unknown algorithm", async () => {
            await expect(
                store.execute("key", ["unknown-algo", 5, 10000, 1, Date.now()])
            ).rejects.toThrow("No Lua script for algorithm");
        });

        it("caches SHA — script LOAD called only once per algorithm", async () => {
            await store.execute("key", [Algorithm.TOKEN, 5, 10000, 1, Date.now()]);
            await store.execute("key", [Algorithm.TOKEN, 5, 10000, 1, Date.now()]);
            await store.execute("key", [Algorithm.TOKEN, 5, 10000, 1, Date.now()]);

            // script LOAD should only be called once — SHA is cached
            expect(mockClient.script).toHaveBeenCalledTimes(1);
        });
    });

    // ─── parseResult ───────────────────────────────────────────
    describe("parseResult — result parsing", () => {
        it("parses allowed result correctly", async () => {
            mockClient.evalsha.mockResolvedValue([1, 4, 5, 1700000060000, 0]);
            const result = await store.execute("key", [Algorithm.TOKEN, 5, 10000, 1, Date.now()]);

            expect(result.allowed).toBe(true);
            expect(result.remaining).toBe(4);
            expect(result.limit).toBe(5);
            expect(result.resetTime).toBe(1700000060000);
            expect(result.retryAfter).toBeUndefined();
        });

        it("parses denied result correctly", async () => {
            mockClient.evalsha.mockResolvedValue([0, 0, 5, 1700000060000, 10]);
            const result = await store.execute("key", [Algorithm.TOKEN, 5, 10000, 1, Date.now()]);

            expect(result.allowed).toBe(false);
            expect(result.remaining).toBe(0);
            expect(result.retryAfter).toBe(10);
        });

        it("retryAfter undefined when 0", async () => {
            mockClient.evalsha.mockResolvedValue([1, 4, 5, 1700000060000, 0]);
            const result = await store.execute("key", [Algorithm.TOKEN, 5, 10000, 1, Date.now()]);
            expect(result.retryAfter).toBeUndefined();
        });

        it("retryAfter defined when > 0", async () => {
            mockClient.evalsha.mockResolvedValue([0, 0, 5, 1700000060000, 5]);
            const result = await store.execute("key", [Algorithm.TOKEN, 5, 10000, 1, Date.now()]);
            expect(result.retryAfter).toBe(5);
        });

        it("includes key in result", async () => {
            mockClient.evalsha.mockResolvedValue([1, 4, 5, 1700000060000, 0]);
            const result = await store.execute("user:123", [Algorithm.TOKEN, 5, 10000, 1, Date.now()]);
            expect(result.key).toBe("user:123");
        });
    });

    // ─── evalsha call structure ────────────────────────────────
    describe("evalsha call structure", () => {
        it("passes prefixed key as KEYS[1]", async () => {
            await store.execute("user:123", [Algorithm.TOKEN, 5, 10000, 1, 1700000000000]);

            const callArgs = mockClient.evalsha.mock.calls[0];
            expect(callArgs[2]).toBe("rl:user:123");
        });

        it("passes 1 as key count", async () => {
            await store.execute("key", [Algorithm.TOKEN, 5, 10000, 1, 1700000000000]);

            const callArgs = mockClient.evalsha.mock.calls[0];
            expect(callArgs[1]).toBe(1);
        });

        it("passes args as strings", async () => {
            await store.execute("key", [Algorithm.TOKEN, 5, 10000, 1, 1700000000000]);

            const callArgs = mockClient.evalsha.mock.calls[0];
            expect(typeof callArgs[3]).toBe("string"); // limit
            expect(typeof callArgs[4]).toBe("string"); // windowMs
            expect(typeof callArgs[5]).toBe("string"); // weight
            expect(typeof callArgs[6]).toBe("string"); // now
        });

        it("uses custom prefix in key", async () => {
            const customStore = new RedisStore({ host: "localhost", prefix: "myapp:" });
            const calls  = (Redis as any).mock.results;
            const client = calls[calls.length - 1].value;
            client.script.mockResolvedValue("fakeSha123");
            client.evalsha.mockResolvedValue(mockLuaResult);

            await customStore.execute("user:123", [Algorithm.TOKEN, 5, 10000, 1, Date.now()]);

            const callArgs = client.evalsha.mock.calls[0];
            expect(callArgs[2]).toBe("myapp:user:123");
        });
    });

    // ─── NOSCRIPT fallback ─────────────────────────────────────
    describe("NOSCRIPT fallback", () => {
        it("falls back to eval on NOSCRIPT error", async () => {
            mockClient.evalsha.mockRejectedValueOnce(new Error("NOSCRIPT No matching script"));
            mockClient.eval.mockResolvedValue(mockLuaResult);

            const result = await store.execute("key", [Algorithm.TOKEN, 5, 10000, 1, Date.now()]);
            expect(result.allowed).toBe(true);
            expect(mockClient.eval).toHaveBeenCalledOnce();
        });

        it("re-caches SHA after NOSCRIPT", async () => {
            mockClient.evalsha.mockRejectedValueOnce(new Error("NOSCRIPT No matching script"));
            mockClient.eval.mockResolvedValue(mockLuaResult);
            mockClient.script.mockResolvedValue("newSha456");

            await store.execute("key", [Algorithm.TOKEN, 5, 10000, 1, Date.now()]);

            // Second call should use new SHA
            mockClient.evalsha.mockResolvedValue(mockLuaResult);
            await store.execute("key", [Algorithm.TOKEN, 5, 10000, 1, Date.now()]);
            expect(mockClient.evalsha.mock.calls[0][0]).toBe("newSha456");
        });
    });

    // ─── Error handling ────────────────────────────────────────
    describe("error handling", () => {
        it("throws when both evalsha and eval fail", async () => {
            mockClient.evalsha.mockRejectedValue(new Error("NOSCRIPT"));
            mockClient.eval.mockRejectedValue(new Error("Redis down"));

            await expect(
                store.execute("key", [Algorithm.TOKEN, 5, 10000, 1, Date.now()])
            ).rejects.toThrow();
        });

        it("throws RateLimitError for unknown algorithm", async () => {
            const { RateLimitError } = await import("../../types/error");
            await expect(
                store.execute("key", ["bad-algorithm", 5, 10000, 1, Date.now()])
            ).rejects.toBeInstanceOf(RateLimitError);
        });
    });
});