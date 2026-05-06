import { Hono } from "hono";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { vi } from "vitest";
import { honoRateLimiter } from "../../middlewares/hono";
import { MemoryStore } from "../../store/memory";
import { RateLimiter } from "../../core/rateLimiter";

const BASIC_CONFIG = { limit: 3, windowMs: 10_000 };

const createApp = (config = {}) => {
    const store = new MemoryStore();
    const limiter = new RateLimiter({ ...BASIC_CONFIG, store, ...config });
    const app = new Hono();

    app.use("*", honoRateLimiter(limiter));
    app.get("/", (c) => c.json({ ok: true }));

    return { app, store, limiter };
};

/**
 * Hono middleware integration tests for RateLimiter.
 *
 * Covers:
 * - request limiting (200 / 429 responses)
 * - rate limit headers (limit, remaining, reset, retry-after)
 * - IP-based isolation via X-Forwarded-For
 * - error handling with failOpen / failClosed behavior
 *
 * Uses Hono test client (app.request) for request simulation.
*/
describe("Hono Middleware", () => {
    // Basic behaviour
    describe("Basic behaviour", () => {
        it("allowes requests under limit", async () => {
            const { app } = createApp();
            for(let i = 0; i < BASIC_CONFIG.limit; i++) {
                const res = await app.request("/");
                expect(res.status).toBe(200);
            }
        });

        it("returns 429 when limit exceeded", async () => {
            const { app } = createApp();
            for(let i = 0; i < BASIC_CONFIG.limit; i++) {
                await app.request("/");
            }

            const res = await app.request("/");
            expect(res.status).toBe(429);
        });

        it("429 response has correct body", async () => {
            const { app } = createApp();
            for(let i = 0; i < BASIC_CONFIG.limit; i++) {
                await app.request("/");
            }

            const res = await app.request("/");
            const body = await res.json();
            expect(body.message).toBe("Too Many Requests");
            expect(body.retryAfter).toBeDefined();
        });
    });

    // Headers
    describe("Headers", () => {
        it("sets X-RateLimit-limit header", async () => {
            const { app } = createApp();
            const res = await app.request("/");
            expect(res.headers.get("x-rateLimit-limit")).toBeDefined();
        });

        it("sets X-RateLimit-Remaining header", async () => {
            const { app } = createApp();
            const res = await app.request("/");
            expect(res.headers.get("x-ratelimit-remaining")).toBeDefined();
        });

        it("sets X-RateLimit-Reset header", async () => {
            const { app } = createApp();
            const res = await app.request("/");
            expect(res.headers.get("x-ratelimit-reset")).toBeDefined();
        });

        it("sets Retry-After on 429", async () => {
            const { app } = createApp();
            for(let i = 0; i < BASIC_CONFIG.limit; i++) {
                await app.request("/");
            }

            const res = await app.request("/");
            expect(res.headers.get("retry-after")).toBeDefined();
        });

        it("remaining decrements correctly", async () => {
            const { app } = createApp();
            for(let i = 0; i < BASIC_CONFIG.limit; i++) {
                const res = await app.request("/");
                const remaining = Number(res.headers.get("x-ratelimit-remaining"));
                expect(remaining).toBe(BASIC_CONFIG.limit - i - 1);
            }
        });

        it("does not set headers when headers=false", async () => {
            const { app } = createApp({ headers: false });
            const res = await app.request("/");
            expect(res.headers.get("x-ratelimit-limit")).toBeNull();
        });
    });

    // IP's isolation
    describe("IP's isolation", () => {
        it("tracks different IP's independently", async () => {
            const { app } = createApp();
            for(let i = 0; i < BASIC_CONFIG.limit; i++) {
                await app.request("/", {
                    headers: { "x-forwarded-for": "1.1.1.1" }
                });
            }

            const res1 = await app.request("/", {
                headers: { "x-forwarded-for": "1.1.1.1" }
            });
            expect(res1.status).toBe(429);

            const res2 = await app.request("/", {
                headers: { "x-forwarded-for": "2.2.2.2" }
            });

            expect(res2.status).toBe(200);
        });
    });

    // Error handling
    describe("Error handling", () => {
        it("returns 500 when store fails and failOpen=false", async () => {
            const { app, store } = createApp({ failOpen: false });
            vi.spyOn(store, "get").mockRejectedValue(new Error("store down"));

            const res = await app.request("/");
            expect(res.status).toBe(500);
        });

        it("allows request when store and failOpen=true", async () => {
            const { app, store } = createApp();
            vi.spyOn(store, "get").mockRejectedValue(new Error("store down"));

            const res = await app.request("/");
            expect(res.status).toBe(200);
        });
    });
});