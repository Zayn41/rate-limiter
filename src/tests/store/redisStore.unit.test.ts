import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("ioredis", () => {
    const mockClient = {
        get: vi.fn(),
        set: vi.fn(),
        del: vi.fn(),
        exists: vi.fn(),
        quit: vi.fn(),
        ping: vi.fn().mockResolvedValue("PONG"),
        on: vi.fn(),
        once: vi.fn((event, cb) => {
            if(event === "ready") cb();
        }),
        status: "ready"
    };

    const MockRedis = vi.fn().mockImplementation(function () {
        return mockClient;
    });

    return {
        Redis: MockRedis,
        default: MockRedis
    };
});

import { RedisStore } from "../../store/redis";
import { Redis } from "ioredis";

/**
 * Unit tests for RedisStore using a mocked ioredis client.
 *
 * These tests validate:
 * - Correct interaction with Redis commands (get/set/del/exists/ping/quit)
 * - Key prefixing behavior
 * - JSON serialization and parsing
 * - Error propagation (no silent failures)
 *
 * ⚠️ Note:
 * - No real Redis connection is used
 * - All Redis behavior is simulated via Vitest mocks
*/
describe("RedisStore Unit", () => {
    let store:      RedisStore;
    let mockClient: any;

    beforeEach(() => {
        vi.clearAllMocks();
        store      = new RedisStore({ host: "localhost" });
        const calls = (Redis as any).mock.results;
        mockClient  = calls[calls.length - 1].value;
    });

    /**
     * Verifies store metadata and client initialization behavior.
     *
     * Ensures:
     * - Store name is correct
     * - Redis error listener is properly registered
    */
    describe("Interface", () => {
        it("has correct name", () => {
            expect(store.name).toBe("RedisStore");
        });

        it("registers error listener on client", () => {
            expect(mockClient.on).toHaveBeenCalledWith("error", expect.any(Function));
        });
    });

    /**
     * Tests retrieval and parsing logic.
     *
     * Ensures:
     * - Missing keys return null
     * - Stored JSON is correctly parsed into objects
     * - Invalid JSON throws an error
     * - Redis errors are not swallowed
     * - Keys are correctly prefixed before lookup
    */
    describe("get()", () => {
        it("returns null when key missing", async () => {
            mockClient.get.mockResolvedValue(null);
            expect(await store.get("key")).toBeNull();
        });

        it("parses JSON from Redis", async () => {
            const state = { type: "token", data: { tokens: 5 }, ttl: 1000 };
            mockClient.get.mockResolvedValue(JSON.stringify(state));
            expect(await store.get("key")).toEqual(state);
        });

        it("throws on corrupted JSON", async () => {
            mockClient.get.mockResolvedValue("not-valid-json{{{");
            await expect(store.get("key")).rejects.toThrow();
        });

        it("throws when Redis throws — no swallowing", async () => {
            mockClient.get.mockRejectedValue(new Error("Redis down"));
            await expect(store.get("key")).rejects.toThrow("Redis down");
        });

        it("prefixes key with rl:", async () => {
            mockClient.get.mockResolvedValue(null);
            await store.get("user:123");
            expect(mockClient.get).toHaveBeenCalledWith("rl:user:123");
        });
    });

    /**
     * Tests data storage behavior.
     *
     * Ensures:
     * - Values are serialized to JSON before storing
     * - TTL is applied using PX (milliseconds)
     * - Invalid TTL values throw errors
     * - Keys are stored with correct prefix
    */
    describe("set()", () => {
        it("uses PX for millisecond TTL", async () => {
            mockClient.set.mockResolvedValue("OK");
            await store.set("key", { type: "token", data: {}, ttl: 5000 } as any, 5000);
            expect(mockClient.set).toHaveBeenCalledWith(
                "rl:key", expect.any(String), "PX", 5000
            );
        });

        it("serializes state to JSON", async () => {
            mockClient.set.mockResolvedValue("OK");
            const state = { type: "token", data: { tokens: 5 }, ttl: 5000 };
            await store.set("key", state as any, 5000);
            const serialized = mockClient.set.mock.calls[0][1];
            expect(JSON.parse(serialized)).toEqual(state);
        });

        it("throws on TTL = 0", async () => {
            await expect(store.set("key", {} as any, 0)).rejects.toThrow();
        });

        it("throws on negative TTL", async () => {
            await expect(store.set("key", {} as any, -1)).rejects.toThrow();
        });
    });

    /**
     * Tests existence checks using Redis EXISTS command.
     *
     * Ensures:
     * - Correct boolean response for key presence
     * - Uses EXISTS instead of GET for efficiency
     * - Keys are properly prefixed
    */
    describe("has()", () => {
        it("returns true when key exists", async () => {
            mockClient.exists.mockResolvedValue(1);
            expect(await store.has("key")).toBe(true);
        });

        it("returns false when key missing", async () => {
            mockClient.exists.mockResolvedValue(0);
            expect(await store.has("key")).toBe(false);
        });

        it("uses EXISTS not GET", async () => {
            mockClient.exists.mockResolvedValue(1);
            await store.has("key");
            expect(mockClient.exists).toHaveBeenCalled();
            expect(mockClient.get).not.toHaveBeenCalled();
        });

        it("uses prefixed key", async () => {
            mockClient.exists.mockResolvedValue(1);
            await store.has("user:123");
            expect(mockClient.exists).toHaveBeenCalledWith("rl:user:123");
        });
    });

    /**
     * Tests key deletion behavior.
     *
     * Ensures:
     * - DEL is called with correct prefixed key
     * - Deleting a non-existent key does not throw
    */
    describe("delete()", () => {
        it("calls del with prefixed key", async () => {
            mockClient.del.mockResolvedValue(1);
            await store.delete("key");
            expect(mockClient.del).toHaveBeenCalledWith("rl:key");
        });

        it("does not throw on missing key", async () => {
            mockClient.del.mockResolvedValue(0);
            await expect(store.delete("nonexistent")).resolves.not.toThrow();
        });
    });

    /**
     * Tests connection health check.
     *
     * Ensures:
     * - Returns true when Redis responds with PONG
     * - Returns false when Redis is unavailable
    */
    describe("ping()", () => {
        it("returns true on PONG", async () => {
            mockClient.ping.mockResolvedValue("PONG");
            expect(await store.ping()).toBe(true);
        });

        it("returns false when Redis is down", async () => {
            mockClient.ping.mockRejectedValue(new Error("connection refused"));
            expect(await store.ping()).toBe(false);
        });
    });

    /**
     * Tests graceful shutdown of Redis client.
     *
     * Ensures:
     * - quit() is called on the client
     * - Connection teardown does not throw errors
     */
    describe("shutdown()", () => {
        it("calls client.quit()", async () => {
            mockClient.quit.mockResolvedValue("OK");
            await store.shutdown();
            expect(mockClient.quit).toHaveBeenCalledOnce();
        });
    });

    /**
     * Verifies support for custom key prefixes.
     *
     * Ensures:
     * - Provided prefix overrides default "rl:"
     * - All operations use the custom prefix correctly
    */
    describe("Custom prefix", () => {
        it("uses custom prefix when provided", async () => {
            const customStore = new RedisStore({ host: "localhost", prefix: "myapp:" });
            const calls  = (Redis as any).mock.results;
            const client = calls[calls.length - 1].value;
            client.get.mockResolvedValue(null);
            await customStore.get("key");
            expect(client.get).toHaveBeenCalledWith("myapp:key");
        });
    });
});