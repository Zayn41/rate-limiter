import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Test, TestingModule } from "@nestjs/testing";
import { Controller, Get, UseGuards } from "@nestjs/common";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { RateLimitModule } from "../../nest/module";
import { RateLimitGuard } from "../../nest/guard";
import { MemoryStore } from "../../store/memory";
import { vi } from "vitest";
import { RateLimiter } from "../../core/rateLimiter";
const BASE_CONFIG = { limit: 3, windowMs: 10_000 };

// Minimal test controller
@Controller()
class TestController {
    @UseGuards(RateLimitGuard)
    @Get("/")
    getHello() {
        return { ok: true };
    }
}

// Helper — creates NestJS app with fresh store each test
const createApp = async (config = {}) => {
    const store = new MemoryStore();

    const moduleRef: TestingModule = await Test.createTestingModule({
        imports: [
            RateLimitModule.forRoot({ ...BASE_CONFIG, store, ...config })
        ],
        controllers: [TestController]
    }).compile();

    const app: INestApplication = moduleRef.createNestApplication();

    const instance = app.getHttpAdapter().getInstance();
    instance.set("trust proxy", true);
    await app.init();

    return { app, store };
};

/**
 * NestJS RateLimitGuard integration tests.
 *
 * Covers:
 * - request limiting via Nest Guard (200 / 429 responses)
 * - HTTP exception formatting (Nest standard error shape)
 * - rate limit headers (limit, remaining, reset, retry-after)
 * - IP isolation behavior via X-Forwarded-For
 * - global guard registration
 * - failOpen / failClosed behavior on store failures
 * - RateLimitModule DI integration (forRoot)
 *
 * Uses supertest against Nest HTTP server.
*/
describe("NestJS RateLimitGuard", () => {
    let app: INestApplication;
    let store: MemoryStore;

    afterEach(async () => {
        store?.clear();
        store?.shutdown();
        await app?.close();
    });

    // ─── Basic behaviour ───────────────────────────────────────
    describe("Basic behaviour", () => {
        it("allows requests under limit", async () => {
            ({ app, store } = await createApp());

            for (let i = 0; i < BASE_CONFIG.limit; i++) {
                const res = await request(app.getHttpServer()).get("/");
                expect(res.status).toBe(200);
            }
        });

        it("returns 429 when limit exceeded", async () => {
            ({ app, store } = await createApp());

            for (let i = 0; i < BASE_CONFIG.limit; i++) {
                await request(app.getHttpServer()).get("/");
            }

            const res = await request(app.getHttpServer()).get("/");
            expect(res.status).toBe(429);
        });

        it("429 response has correct body", async () => {
            ({ app, store } = await createApp());

            for (let i = 0; i < BASE_CONFIG.limit; i++) {
                await request(app.getHttpServer()).get("/");
            }

            const res = await request(app.getHttpServer()).get("/");
            expect(res.body.message).toBe("Too Many Requests");
            expect(res.body.retryAfter).toBeDefined();
            expect(res.body.statusCode).toBe(429);
        });

        it("allows request after window resets", async () => {
            ({ app, store } = await createApp());

            for (let i = 0; i < BASE_CONFIG.limit; i++) {
                await request(app.getHttpServer()).get("/");
            }

            expect(
                (await request(app.getHttpServer()).get("/")).status
            ).toBe(429);

            // Manually clear store to simulate window reset
            store.clear();

            expect(
                (await request(app.getHttpServer()).get("/")).status
            ).toBe(200);
        });
    });

    // ─── Headers ───────────────────────────────────────────────
    describe("Headers", () => {
        beforeEach(async () => {
            ({ app, store } = await createApp());
        });

        it("sets X-RateLimit-Limit header", async () => {
            const res = await request(app.getHttpServer()).get("/");
            expect(res.headers["x-ratelimit-limit"]).toBeDefined();
            expect(Number(res.headers["x-ratelimit-limit"])).toBe(BASE_CONFIG.limit);
        });

        it("sets X-RateLimit-Remaining header", async () => {
            const res = await request(app.getHttpServer()).get("/");
            expect(res.headers["x-ratelimit-remaining"]).toBeDefined();
        });

        it("sets X-RateLimit-Reset header", async () => {
            const res = await request(app.getHttpServer()).get("/");
            expect(res.headers["x-ratelimit-reset"]).toBeDefined();
        });

        it("remaining decrements on each request", async () => {
            for (let i = 0; i < BASE_CONFIG.limit; i++) {
                const res       = await request(app.getHttpServer()).get("/");
                const remaining = Number(res.headers["x-ratelimit-remaining"]);
                expect(remaining).toBe(BASE_CONFIG.limit - i - 1);
            }
        });

        it("sets Retry-After header on 429", async () => {
            for (let i = 0; i < BASE_CONFIG.limit; i++) {
                await request(app.getHttpServer()).get("/");
            }
            const res = await request(app.getHttpServer()).get("/");
            expect(res.headers["retry-after"]).toBeDefined();
        });

        it("does not set headers when headers=false", async () => {
            await app.close();
            ({ app, store } = await createApp({ headers: false }));

            const res = await request(app.getHttpServer()).get("/");
            expect(res.headers["x-ratelimit-limit"]).toBeUndefined();
            expect(res.headers["x-ratelimit-remaining"]).toBeUndefined();
        });
    });

    // ─── IP isolation ──────────────────────────────────────────
    describe("IP isolation", () => {
        beforeEach(async () => {
            ({ app, store } = await createApp());
        });

        it("tracks different IPs independently", async () => {
            // exhaust ip1
            for (let i = 0; i < BASE_CONFIG.limit; i++) {
                await request(app.getHttpServer())
                    .get("/")
                    .set("x-forwarded-for", "1.1.1.1");
            }

            // ip1 blocked
            const res1 = await request(app.getHttpServer())
                .get("/")
                .set("x-forwarded-for", "1.1.1.1");
            expect(res1.status).toBe(429);

            // ip2 unaffected
            const res2 = await request(app.getHttpServer())
                .get("/")
                .set("x-forwarded-for", "2.2.2.2");
            expect(res2.status).toBe(200);
        });
    });

    // ─── Guard specific ────────────────────────────────────────
    describe("Guard behaviour", () => {
        it("can be applied globally", async () => {
            const store      = new MemoryStore();
            const moduleRef  = await Test.createTestingModule({
                imports:     [RateLimitModule.forRoot({ ...BASE_CONFIG, store })],
                controllers: [TestController]
            }).compile();

            const globalApp = moduleRef.createNestApplication();
            // Apply guard globally
            const { RateLimitGuard: Guard } = await import("../../nest/guard");
            const limiter = moduleRef.get(RateLimiter);
            globalApp.useGlobalGuards(new Guard(limiter));
            await globalApp.init();

            const res = await request(globalApp.getHttpServer()).get("/");
            expect(res.status).toBe(200);

            await globalApp.close();
            store.clear();
            store.shutdown();
        });

        it("throws HttpException not generic error on limit", async () => {
            ({ app, store } = await createApp());

            for (let i = 0; i < BASE_CONFIG.limit; i++) {
                await request(app.getHttpServer()).get("/");
            }

            const res = await request(app.getHttpServer()).get("/");
            // NestJS formats HttpException correctly
            expect(res.status).toBe(429);
            expect(res.body).toHaveProperty("statusCode", 429);
            expect(res.body).toHaveProperty("message");
        });
    });

    // ─── failOpen ──────────────────────────────────────────────
    describe("failOpen", () => {
        it("allows request when store fails and failOpen=true", async () => {
            ({ app, store } = await createApp());
            vi.spyOn(store, "get").mockRejectedValue(new Error("store down"));

            const res = await request(app.getHttpServer()).get("/");
            expect(res.status).toBe(200);
        });

        it("returns 500 when store fails and failOpen=false", async () => {
            ({ app, store } = await createApp({ failOpen: false }));
            vi.spyOn(store, "get").mockRejectedValue(new Error("store down"));

            const res = await request(app.getHttpServer()).get("/");
            expect(res.status).toBe(500);
        });
    });

    // ─── Module ────────────────────────────────────────────────
    describe("RateLimitModule", () => {
        it("forRoot provides RateLimiter instance", async () => {
            ({ app, store } = await createApp());

            const moduleRef = await Test.createTestingModule({
                imports: [RateLimitModule.forRoot({ ...BASE_CONFIG, store })]
            }).compile();

            const { RateLimiter: Limiter } = await import("../../core/rateLimiter");
            const limiter = moduleRef.get(Limiter);
            expect(limiter).toBeDefined();
        });

        it("forRoot provides RateLimitGuard", async () => {
            const moduleRef = await Test.createTestingModule({
                imports: [RateLimitModule.forRoot({
                    ...BASE_CONFIG,
                    store: new MemoryStore()
                })]
            }).compile();

            const { RateLimitGuard: Guard } = await import("../../nest/guard");
            const guard = moduleRef.get(Guard);
            expect(guard).toBeDefined();
        });
    });
});