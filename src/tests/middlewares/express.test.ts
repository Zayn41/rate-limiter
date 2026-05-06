import request from "supertest";
import express from "express";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { RateLimiter } from "../../core/rateLimiter";
import { MemoryStore } from "../../store/memory";
import { expressRateLimiter } from "../../middlewares/express";

const BASE_CONFIG = { limit: 3, windowMs: 10_000 };

// create app for express middleware test
const createApp = (config = {}) => {
    const store = new MemoryStore();
    const limiter = new RateLimiter({ ...BASE_CONFIG, store, ...config }); 
    const app = express(); // initialize express 

    // Intialize express rate limiter
    app.set("trust proxy", 1);
    app.use(expressRateLimiter(limiter));

    app.get("/", (req, res) => res.json({ ok: true }));

    // Error middleware — required
    app.use((err: any, req: any, res: any, next: any) => {
        res.status(500).json({ message: "Internal Server Error" });
    });

    return { app, store, limiter };
};

/**
 * Express middleware integration tests for RateLimiter.
 *
 * Validates:
 * - request limiting behavior (200 / 429 responses)
 * - response headers (rate limit metadata)
 * - IP-based isolation
 * - error handling + fail-open behavior
 * - configuration overrides (e.g. headers=false)
 *
 * Uses supertest to simulate real HTTP requests.
*/
describe("Express Middleware", () => {
    // Basic behaviour
    describe("Basic behaviour", () => {
        it("passes request when under limit", async () => {
            const { app } = createApp();
            const res = await request(app).get("/");
            expect(res.status).toBe(200);
        });

        it("returns 429 when limit exceed", async () => {
            const { app } = createApp();
            for(let i = 0; i < BASE_CONFIG.limit; i++) {
                await request(app).get("/");
            }

            const res = await request(app).get("/");
            expect(res.status).toBe(429);
        });

        it("429 response has correct body", async () => {
            const { app } = createApp();

            for(let i = 0; i < BASE_CONFIG.limit; i++) {
                await request(app).get("/");
            }

            const res = await request(app).get("/");
            expect(res.status).toBe(429);
            expect(res.body.message).toBe("Too Many Requests");
            expect(res.body.retryAfter).toBeDefined();
        });
    });

    // Headers
    describe("Headers", () => {
        it("sets X-RateLimit-Limit header", async () => {
            const { app } = createApp();
            const res = await request(app).get("/");
            expect(res.headers["x-ratelimit-limit"]).toBe(String(BASE_CONFIG.limit));
        });

        it("sets X-RateLimit-Remaining header", async () => {
            const { app } = createApp();
            const res = await request(app).get("/");
            expect(res.headers["x-ratelimit-remaining"]).toBeDefined();
        });

        it("sets X-RateLimit-reset header", async () => {
            const { app } = createApp();
            const res = await request(app).get("/");
            expect(res.headers["x-ratelimit-reset"]).toBeDefined();
        });

        it("sets Retry-After header on 429", async () => {
            const { app } = createApp();
            for(let i = 0; i < BASE_CONFIG.limit; i++) {
                await request(app).get("/");
            }

            const res = await request(app).get("/");
            expect(res.headers["retry-after"]).toBeDefined();
        });

        it("remaining decrements on each requests", async () => {
            const { app } = createApp();
            for(let i = 0; i < BASE_CONFIG.limit; i++) {
                const res = await request(app).get("/");
                const remaining = Number(res.headers["x-ratelimit-remaining"]);
                expect(remaining).toBe(BASE_CONFIG.limit - i - 1);
            }
        });

        it("does not set headers when headers=false", async () => {
            const { app } = createApp({ headers: false });
            const res = await request(app).get("/");
            expect(res.headers["x-ratelimit-limit"]).toBeUndefined();
            expect(res.headers["x-ratelimit-remaining"]).toBeUndefined();
        });
    });

    // IP isolation
    describe("IP isolation", () => {
        it("tracks different IPs independently", async () => {
            const { app } = createApp();
            for(let i = 0; i < BASE_CONFIG.limit; i++) {
                await request(app).get("/").set("x-forwarded-for", "1.1.1.1");
            }

            // ip1 blocked 
            const res1 = await request(app).get("/").set("x-forwarded-for", "1.1.1.1");
            expect(res1.status).toBe(429);

            // ip2 not blocked 
            const res2 = await request(app).get("/").set("x-forwarded-for", "2.2.2.2");
            expect(res2.status).toBe(200);
        });
    });

    // Error handling
    describe("Error handling", () => {
        it("calls next(error) when handler throws", async () => {
            const app = express();
            const store = new MemoryStore();
            const limiter = new RateLimiter({ ...BASE_CONFIG, store });

            // Simulate store failure
            vi.spyOn(store, "get").mockRejectedValue(new Error("store down"));

            app.use(expressRateLimiter(limiter));
            app.get("/", (req, res) => res.json({ ok: true }));
            app.use((err: any, req: any, res: any, next: any) => {
                res.status(500).json({ message: err.message });
            });

            const res = await request(app).get("/");
            // failOpen=true by default — still allowed
            expect(res.status).toBe(200);
        });
    });
});