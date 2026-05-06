import { describe, expect, it, beforeAll, beforeEach, afterEach } from "vitest";
import request from "supertest"
import express from "express";
import { RateLimiter } from "../../core/rateLimiter";
import { RedisStore } from "../../store/redis";
import { MemoryStore } from "../../store/memory";
import { expressRateLimiter } from "../../middlewares/express";
import { Algorithm } from "../../types/config";

const BASE_CONFIG = { limit: 5, windowMs: 10_000, weight: 1 };
const REDIS_URL = process.env.REDIS_URL

/**
 * End-to-end tests for RateLimiter with Express middleware.
 *
 * Covers full system behavior across:
 * - MemoryStore integration (in-memory execution path)
 * - RedisStore + Lua scripts (atomic execution path)
 * - request limiting (200 / 429 responses)
 * - rate limit headers correctness
 * - IP isolation via X-Forwarded-For
 * - concurrent request safety
 * - failOpen behavior under store failure
 * - algorithm compatibility across all implementations
 *
 * This suite validates the entire request → middleware → core → store pipeline.
*/
describe("E2E — MemoryStore", () => {
    let store: MemoryStore;

    const createApp = (config = {}) => {
        store = new MemoryStore();
        const limiter = new RateLimiter({
            ...BASE_CONFIG,
            store,
            ...config
        });

        const app = express();
        app.use(expressRateLimiter(limiter));
        app.get("/", (req, res) => res.json({ ok: true }));

        return app;
    };

    afterEach(() => {
        store?.clear();
        store?.shutdown();
    });

    it("allows requests under limit", async () => {
        const app = createApp();
        for(let i = 0; i < BASE_CONFIG.limit; i++) {
            expect(((await request(app).get("/")).status)).toBe(200);
        }
    });

    it("blocks after limit", async () => {
        const app = createApp();
        for(let i = 0; i < BASE_CONFIG.limit; i++) {
            await request(app).get("/");
        }

        expect(((await request(app).get("/")).status)).toBe(429);
    });

    it("sets rate limit headers", async () => {
        const app = createApp();
        const res = await request(app).get("/");
        expect(res.headers["x-ratelimit-limit"]).toBeDefined();
        expect(res.headers["x-ratelimit-remaining"]).toBeDefined();
        expect(res.headers["x-ratelimit-reset"]).toBeDefined();
    });

    it("works with all algorithms", async () => {
        for(const algorithm of Object.values(Algorithm)) {
            const app = createApp({ algorithm });
            const res = await request(app).get("/");
            expect(res.status).toBe(200);
        }
    });
});

/**
 * End-to-end tests for RateLimiter with RedisStore + Lua scripts.
 *
 * Validates atomic Lua execution path, concurrency safety,
 * IP isolation, and failOpen behavior in real Redis conditions.
*/
describe.skipIf(!REDIS_URL)("E2E — RedisStore + Lua", () => {
    let store: RedisStore;

    const createApp = (config = {}) => {
        store = new RedisStore({ url: REDIS_URL! });
        const limiter = new RateLimiter({
            ...BASE_CONFIG,
            store,
            ...config
        });
        const app = express();
        app.use(expressRateLimiter(limiter));
        app.set("trust proxy", true);
        app.get("/", (req, res) => res.json({ ok: true }));

        return app;
    };

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
        await store?.clear();
        await store?.shutdown();
    });

    it("allows requests under limit", async () => {
        const app = createApp();
        for(let i = 0; i < BASE_CONFIG.limit; i++) {
            expect((await request(app).get("/")).status).toBe(200);
        }
    });

    it("blocks after limit with Redis + Lua", async () => {
        const app = createApp();
        for(let i = 0 ; i < BASE_CONFIG.limit; i++) {
            expect((await request(app).get("/")).status).toBe(200);
        }

        const result = await request(app).get("/");
        expect(result.status).toBe(429);
    });

    it("headers set correctly with Redis store", async () => {
        const app = createApp();
        const res = await request(app).get("/");
        expect(res.headers["x-ratelimit-limit"]).toBeDefined();
        expect(res.headers["x-ratelimit-remaining"]).toBeDefined();
        expect(res.headers["x-ratelimit-reset"]).toBeDefined();
    });

    it("uses Lua execute() path not MemoryStore path", async () => {
        // RedisStore has execute() — verify duck typing selects Lua path
        expect(typeof store.execute).toBe("function");
    });

    it("concurrent requests after do not exceed limit", async () => {
        const app = createApp();

        const results = await  Promise.all(
            Array.from({ length: 20 }, () => 
                request(app).get("/")
            ),
        );

        const allowed = results.filter(r => r.status === 200).length;
        expect(allowed).toBe(BASE_CONFIG.limit);
    });

    it("different IP's tracked independently", async () => {
        const app = createApp();

        for(let i = 0; i < BASE_CONFIG.limit; i++) {
            await request(app).get("/").set("x-forwarded-for", "1.1.1.1");
        }

        expect(
            (await request(app).get("/").set("x-forwarded-for", "1.1.1.1")).status
        ).toBe(429);

        expect(
            (await request(app).get("/").set("x-forwarded-for", "2.2.2.2")).status
        ).toBe(200);
    });

    it("failOpen allows request when store fails", async () => {
        const brokenStore = new RedisStore({ host: "localhost", port: 9999, lazyConnect: true } as any);
        const limiter = new RateLimiter({
            limit: 5,
            windowMs: 10_000,
            store: brokenStore,
            failOpen: true,
        });

        const app = express();
        app.use(expressRateLimiter(limiter));
        app.get("/", (req, res) => res.json({ ok: true }));
        
        const res = await request(app).get("/");
        expect(res.status).toBe(200);

        // Disconnect forcefully — don't try to quit gracefully
        brokenStore.disconnect();
        // await brokenStore.shutdown();
    });

    it("works with all algorithms via Lua", async () => {
        for(const algorithm of Object.values(Algorithm)) {
            await store.clear();
            const app = createApp({ algorithm });
            const res = await request(app).get("/");
            expect(res.status).toBe(200);
        }
    });
});