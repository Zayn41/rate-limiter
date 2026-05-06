import Fastify from "fastify";
import { describe, it, expect, inject, vi } from "vitest";
import { MemoryStore } from "../../store/memory";
import { RateLimiter } from "../../core/rateLimiter";
import { fastifyRateLimiter } from "../../middlewares/fastify";

const BASE_CONFIG = { limit: 3, windowMs: 10_000 };

// create app for fastify middleware test
const createApp = async (config = {}) => {
    const store = new MemoryStore();
    const limiter = new RateLimiter({ ...BASE_CONFIG, store, ...config });
    const app = Fastify({ trustProxy: true });

    // Register hook — runs before every route
    app.addHook("onRequest", fastifyRateLimiter(limiter));
    app.get("/", async () => ({ ok: true }));

    await app.ready();
    return { app, store, limiter };
};

/**
 * Fastify middleware integration tests for RateLimiter.
 *
 * Covers:
 * - request limiting behavior (200 / 429 / 500)
 * - rate limit headers (limit, remaining, reset, retry-after)
 * - IP isolation via X-Forwarded-For
 * - failOpen / failClosed behavior on store errors
 *
 * Uses Fastify inject() for request simulation.
*/
describe("Fastify Middleware", () => {
    // Basic bahviour
    describe("Basic behaviour", () => {
        it("passes request when under limit", async () => {
            const { app } = await createApp();
            const res = await app.inject({ method: "GET", url: "/ "});
            expect(res.statusCode).toBe(200);
        });

        it("returns 429 when limit exceeds", async () => {
            const { app } = await createApp();
            for(let i = 0; i < BASE_CONFIG.limit; i++) {
                await app.inject({ method: "GET", url: "/" });
            }

            const res = await app.inject({ method: 'GET', url: "/" });
            expect(res.statusCode).toBe(429);
        });

        it("429 response has correct body", async () => {
            const { app } = await createApp();
            for(let i = 0; i < BASE_CONFIG.limit; i++) {
                await app.inject({ method: "GET", url: "/" });
            }

            const res = await app.inject({ method: "GET", url: "/" });
            const body = res.json();
            expect(body.message).toBe("Too Many Requests");
            expect(body.retryAfter).toBeDefined();
        });
    });

    // Headers
    describe("Headers", () => {
        it("sets X-RateLimit-Limit header", async () => {
            const { app } = await createApp();
            const res = await app.inject({ method: "GET", url: "/" });
            expect(res.headers["x-ratelimit-limit"]).toBeDefined();
        });

        it("sets X-RateLimit-Remaining header", async () => {
            const { app } = await createApp();
            const res = await app.inject({ method: "GET", url: "/" });
            expect(res.headers["x-ratelimit-remaining"]).toBeDefined();
        });

        it("sets X-RateLimit-reset header", async () => {
            const { app } = await createApp();
            const res = await app.inject({ method: "GET", url: "/" });
            expect(res.headers["x-ratelimit-reset"]).toBeDefined();
        });

        it("sets retryAfter on 429", async () => {
            const { app } = await createApp();
            for(let i = 0; i < BASE_CONFIG.limit; i++) {
                await app.inject({ method: "GET", url: "/" });
            }

            const res = await app.inject({ method: "GET", url: "/" });
            expect(res.headers["retry-after"]).toBeDefined()
        });

        it("remaining decrements correctly", async () => {
            const { app } = await createApp();
            for(let i = 0; i < BASE_CONFIG.limit; i++) {
                const res = await app.inject({ method: "GET", url: "/" });
                const remaining = Number(res.headers["x-ratelimit-remaining"]);
                expect(remaining).toBe(BASE_CONFIG.limit - i - 1);
            }
        });

        it("does not headers when headers=false", async () => {
            const { app } = await createApp({ headers: false });
            const res = await app.inject({ method: "GET", url: "/" });
            expect(res.headers["x-ratelimit-limit"]).toBeUndefined();
        });
    });

    // IPs isolation
    describe("IPs isolation", () => {
        it("tracks different IPs independently", async () => {
            const { app } = await createApp();
            for(let i = 0; i < BASE_CONFIG.limit; i++) {
                await app.inject({
                    method: "GET",
                    url: "/",
                    headers: { "x-forwarded-for": "1.1.1.1" }
                });
            }

            const res1 = await app.inject({
                method: "GET",
                url: "/",
                headers: { "x-forwarded-for": "1.1.1.1" }
            });

            expect(res1.statusCode).toBe(429);

            const res2 = await app.inject({
                method: "GET",
                url: "/",
                headers: { "x-forwarded-for": "2.2.2.2" }
            });

            expect(res2.statusCode).toBe(200);
        });
    });

    // Error handling
    describe("Error handling", async () => {
        it("returns 500 when store thows and failOpen=false", async () => {
            const store = new MemoryStore();
            const limiter = new RateLimiter({
                ...BASE_CONFIG,
                store,
                failOpen: false
            });
            const app = Fastify();

            vi.spyOn(store, "get").mockRejectedValue(new Error("store down"));

            app.addHook("onRequest", fastifyRateLimiter(limiter));
            app.get("/", async () => ({ ok: true }));
            await app.ready();

            const res = await app.inject({ method: "GET", url: "/" });
            expect(res.statusCode).toBe(500);
        });

        it("allow requests when store fails and failOpen=true", async () => {
            const store = new MemoryStore();
            const limiter = new RateLimiter({ ...BASE_CONFIG, store });
            const app = Fastify();

            vi.spyOn(store, "get").mockRejectedValue(new Error("store down"));

            app.addHook("onRequest", fastifyRateLimiter(limiter));
            app.get("/", async () => ({ ok: true }));
            await app.ready();

            const res = await app.inject({ method: "GET", url: "/" });
            expect(res.statusCode).toBe(200);
        });
    });
});