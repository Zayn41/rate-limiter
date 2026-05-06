import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { setupMockTime, advanceTime, resetTime } from "../utils/mockTime";
import { RateLimiter } from "../../core/rateLimiter";
import { MemoryStore } from "../../store/memory";
import { Algorithm } from "../../types/config";
import { RateLimitError } from "../../types/error";

const BASE_TIME = 1_700_000_000_000;

/**
 * Minimal request shape used for RateLimiter unit testing.
 * Simulates HTTP-like request context without framework dependency.
*/
interface MockRequest {
    ip: string;
    path: string;
    method: string;
    headers: Record<string, string>;
}

/**
 * Creates a mock request object for testing RateLimiter behavior.
 * Defaults to localhost IP if none provided.
*/
const mockReq = (ip = "127.0.0.1"): MockRequest => ({
    ip,
    path: "/test",
    method: "GET",
    headers: {}
});

// MockResult Data
const mockRes = {};

// limit settings
const BASE_CONFIG = {
    limit: 5,
    windowMs: 10_000
};

// RateLimiter Orchestrator Test
describe("RateLimiter Orchestrator", () => {
    let store: MemoryStore,
    limiter: RateLimiter<MockRequest>;

    beforeEach(() => {
        setupMockTime(BASE_TIME);
        store = new MemoryStore();
        limiter = new RateLimiter({ ...BASE_CONFIG, store });
    });

    afterEach(() => {
        store.clear();
        store.shutdown();
        resetTime();
    });

    // Basic rate limiting
    describe("Basic rate limiting", () => {
        it("allows requests under limit", async () => {
            for(let i = 0; i < BASE_CONFIG.limit; i++) {
                const res = await limiter.handler(mockReq(), mockRes);
                expect(res.allowed).toBe(true);
            }
        });

        it("denies request over limit", async () => {
            for(let i = 0; i < BASE_CONFIG.limit; i++) {
                await limiter.handler(mockReq(), mockRes);
            }

            const res = await limiter.handler(mockReq(), mockRes);
            expect(res.allowed).toBe(false);
        });

        it("result contains correct field", async () => {
            const result = await limiter.handler(mockReq(), mockRes);
            expect(result).toHaveProperty("allowed");
            expect(result).toHaveProperty("remaining");
            expect(result).toHaveProperty("limit");
            expect(result).toHaveProperty("resetTime");
        });

        it("remaining decrements on each request", async () => {
            for(let i = 0; i < BASE_CONFIG.limit; i++) {
                const res = await limiter.handler(mockReq(), mockRes);
                expect(res.remaining).toBe(BASE_CONFIG.limit - i - 1);
            }
        });

        it("result.limitt matches config.limit", async () => {
            const res = await limiter.handler(mockReq(), mockRes);
            expect(res.limit).toBe(BASE_CONFIG.limit);
        });

        it("resets after window expires", async () => {
            for(let i = 0; i < BASE_CONFIG.limit; i++) {
                await limiter.handler(mockReq(), mockRes);
            }

            const res1 = await limiter.handler(mockReq(), mockRes);
            expect(res1.allowed).toBe(false);

            advanceTime(BASE_CONFIG.windowMs + 1); // move to new window

            const res2 = await limiter.handler(mockReq(), mockRes);
            expect(res2.allowed).toBe(true);
        });
    });

    // Key isolation
    describe("Key isolation", () => {
        it("different IP's have independent limits", async () => {
            // exhaust ip1
            for(let i = 0; i < BASE_CONFIG.limit; i++) {
                await limiter.handler(mockReq("1.1.1.1"), mockRes);
            }

            const res1 = await limiter.handler(mockReq("1.1.1.1"), mockRes);
            expect(res1.allowed).toBe(false);

            // ip2 should be unaffected
            const res2 = await limiter.handler(mockReq("2.2.2.2"), mockRes);
            expect(res2.allowed).toBe(true);
        });

        it("custom keyGenerator is used", async () => {
            const customLimiter = new RateLimiter<MockRequest>({
                ...BASE_CONFIG,
                store,
                keyGenerator: () => "fixed-key" // all requests share one key
            });

            for(let i = 0; i < BASE_CONFIG.limit; i++) {
                await customLimiter.handler(mockReq("1.1.1.1"), mockRes);
            }

            // different IP but same key — should be denied
            const result = await customLimiter.handler(mockReq("2.2.2.2"), mockRes);
            expect(result.allowed).toBe(false);
        });
    });

    // skip
    describe("skip", () => {
        it("skips rate limiting when skip() returns true", async () => {
            const skipLimiter = new RateLimiter<MockRequest>({
                ...BASE_CONFIG,
                store,
                skip: () => true
            });

            // exhaust would normally block — but skip bypasses it
            for(let i = 0; i < BASE_CONFIG.limit * 2; i++) {
                const result = await skipLimiter.handler(mockReq(), mockRes);
                expect(result.allowed).toBe(true);
            }
        });

        it("skip result has full remaining", async () => {
            const skipLimiter = new RateLimiter<MockRequest>({
                ...BASE_CONFIG,
                store,
                skip: () => true
            });

            const result = await skipLimiter.handler(mockReq(), mockRes);
            expect(result.remaining).toBe(BASE_CONFIG.limit);
        });
    });

    // failOpen
    describe("failOpen", () => {
        it("allows request when store fails and failOpen=true", async () => {
            vi.spyOn(store, "get").mockRejectedValue(new Error("store down"));

            const result = await limiter.handler(mockReq(), mockRes);
            expect(result.allowed).toBe(true);
            expect(result.remaining).toBe(-1);
        });

        it("throws when store fails and failOpen=false", async () => {
            const strictLimiter = new RateLimiter<MockRequest>({
                ...BASE_CONFIG,
                store,
                failOpen: false
            });

            vi.spyOn(store, "get").mockRejectedValue(new Error("store down"));

            await expect(
                strictLimiter.handler(mockReq(), mockRes)
            ).rejects.toThrow();
        });
    });

    // Plugins
    describe("Plugins", () => {
        it("calls onRequestStart on each request", async () => {
            const onRequestStart = vi.fn();
            const pluginLimiter = new RateLimiter<MockRequest>({
                ...BASE_CONFIG,
                store,
                plugins: [{ name: "test", onRequestStart }]
            });

            await pluginLimiter.handler(mockReq(), mockRes);
            expect(onRequestStart).toHaveBeenCalledOnce();
        });

        it("calls onRequestEnd with result", async () => {
            const onRequestEnd = vi.fn();
            const pluginLimiter = new RateLimiter<MockRequest>({
                ...BASE_CONFIG,
                store,
                plugins: [{ name: "test", onRequestEnd }]
            });

            await pluginLimiter.handler(mockReq(), mockRes);
            expect(onRequestEnd).toHaveBeenCalledOnce();
            expect(onRequestEnd.mock.calls[0]![1]).toHaveProperty("allowed");
        });

        it("calls onError when store throws", async () => {
            const onError = vi.fn();
            const pluginLimiter = new RateLimiter<MockRequest>({
                ...BASE_CONFIG,
                store,
                plugins: [{ name: "test", onError }]
            });

            vi.spyOn(store, "get").mockRejectedValue(new Error("store down"));

            await pluginLimiter.handler(mockReq(), mockRes);
            expect(onError).toHaveBeenCalledOnce();
        });


        it("skips disable plugins", async () => {
            const hook = vi.fn();
            const pluginLimiter = new RateLimiter<MockRequest>({
                ...BASE_CONFIG,
                store,
                plugins: [{ name: "test", enabled: false, onRequestStart: hook }]
            });

            await pluginLimiter.handler(mockReq(), mockRes);
            expect(hook).not.toHaveBeenCalled();
        });

        it("plugin error does not crash the limiter", async () => {
            const pluginLimiter = new RateLimiter<MockRequest>({
                ...BASE_CONFIG,
                store,
                plugins: [{ 
                    name: "bad-plugin",
                    onRequestStart: () => { throw new Error("plugin crash") } 
                }]
            });

            await expect(
                pluginLimiter.handler(mockReq(), mockRes)
            ).resolves.not.toThrow();
        });
    });

    // onLimitReached
    describe("onLimitReached", () => {
        it("calls onLimitReached when denied", async () => {
            const onLimitReached = vi.fn();
            const strictLimiter = new RateLimiter<MockRequest>({
                ...BASE_CONFIG,
                store,
                onLimitReached
            });

            for(let i = 0; i < BASE_CONFIG.limit; i++) {
                await strictLimiter.handler(mockReq(), mockRes);
            }

            await strictLimiter.handler(mockReq(), mockRes);
            expect(onLimitReached).toHaveBeenCalledOnce();
        });

        it("does not call onLimitReached when allowed", async () => {
            const onLimitReached = vi.fn();
            const strictLimiter = new RateLimiter({
                ...BASE_CONFIG,
                store,
                onLimitReached
            });

            await strictLimiter.handler(mockReq(), mockRes);
            expect(onLimitReached).not.toHaveBeenCalled();
        });
    });

    // Algorithm Selection
    describe("Algorithm selection", () => {
        it("uses token bucket by default", async () => {
            const result = await limiter.handler(mockReq(), mockRes);
            expect(result.allowed).toBe(true);
        });

        it("uses fixed window when configrured", async () => {
            const fixedLimiter = new RateLimiter<MockRequest>({
                ...BASE_CONFIG,
                store,
                algorithm: Algorithm.FIXED
            });

            const result = await fixedLimiter.handler(mockReq(), mockRes);
            expect(result.allowed).toBe(true);
        });
    })

    // reset
    describe("reset", () => {
        it("reset() clears limit for a request", async () => {
            for(let i = 0; i < BASE_CONFIG.limit; i++) {
                await limiter.handler(mockReq(), mockRes);
            }

            const res1 = await limiter.handler(mockReq(), mockRes);
            expect(res1.allowed).toBe(false);

            await limiter.reset(mockReq());

            const res2 = await limiter.handler(mockReq(), mockRes);
            expect(res2.allowed).toBe(true);
        });

        it("resetKey() clears limit for a specific key", async () => {
            for (let i = 0; i < BASE_CONFIG.limit; i++) {
                await limiter.handler(mockReq("1.1.1.1"), mockRes);
            }
            expect((await limiter.handler(mockReq("1.1.1.1"), mockRes)).allowed).toBe(false);

            await limiter.resetKey("1.1.1.1");

            expect((await limiter.handler(mockReq("1.1.1.1"), mockRes)).allowed).toBe(true);
        });
    });

    // Config validation
    describe("Config validation", async () => {
        it("throws on missing store", () => {
            expect(() => new RateLimiter({
                limit: 5,
                windowMs: 10_000,
                store: null as any
            })).toThrow(RateLimitError);
        });

        it("throws an invalid limit", () => {
            expect(() => new RateLimiter({
                limit: -1,
                windowMs: 10_000,
                store
            })).toThrow(RateLimitError);
        });
    });
});