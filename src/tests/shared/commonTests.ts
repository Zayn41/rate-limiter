import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { RateLimitAlgorithm } from "../../types/algorithm";
import { setupMockTime, advanceTime, resetTime } from "../utils/mockTime";

const BASE_TIME = 1_700_000_000_000;
const BASE_CONFIG = { limit: 5, windowMs: 10_000, weight: 1 };

/**
 * Runs a shared compliance test suite for all RateLimitAlgorithm implementations.
 *
 * This function defines a standardized set of behavioral tests that every
 * rate-limiting algorithm must pass, ensuring consistency across:
 *
 * - Token Bucket
 * - Fixed Window
 * - Sliding Window Log
 * - Sliding Window Count
 *
 * It validates correctness of:
 * - Request allowance/denial logic
 * - Remaining quota calculations
 * - Retry-after behavior
 * - State consistency and immutability
 * - TTL validity
 * - Time-based resets
 * - Weight handling
 * - Performance characteristics
 *
 * @param createAlgo - Factory function that creates a fresh algorithm instance
 *
 * @param options - Optional configuration for test behavior
 * @param options.skipHardResetTests - If true, skips tests that depend on full
 * window expiry/reset timing (useful for non-time-based or approximate implementations)
 *
 * @example
 * ```ts
 * runCommonTests(() => new TokenBucketAlgorithm());
 * runCommonTests(() => new SlidingWindowLogAlgorithm(), {
 *   skipHardResetTests: true
 * });
 * ```
 *
 * @remarks
 * This is intended to be used only in test files.
 * It is NOT part of the production runtime API.
*/
export const runCommonTests = (
    createAlgo: () => RateLimitAlgorithm, 
    options: { skipHardResetTests?: boolean } = {}
) => {
    let algo: RateLimitAlgorithm;

    beforeEach(() => {
        setupMockTime(BASE_TIME);
        algo = createAlgo();
    });

    afterEach(() => {
        resetTime();
    });

    // Helper function
    const exhaust = (state: any, config = BASE_CONFIG) => {
        for(let i = 0; i < config.limit; i++) {
            state = algo.process(state, config).newState;
        }
        return state;
    };

    describe("Basic Behaviour", () => {
        it("allows requests under limit", () => {
            let state = null;

            for(let i = 0; i < BASE_CONFIG.limit; i++) {
                const res = algo.process(state, BASE_CONFIG);
                expect(res.result.allowed).toBe(true);
                state = res.newState;
            }
        });

        it("denies when limit exceeded", () => {
            const state = exhaust(null);
            const res = algo.process(state, BASE_CONFIG);
            expect(res.result.allowed).toBe(false);
        });

        it("handles null state as first request", () => {
            const res = algo.process(null, BASE_CONFIG);
            expect(res.result.allowed).toBe(true);
            expect(res.newState).not.toBeNull();
        }); 

        it("handles multiple requests at exact same timestamp", () => {
            let state = null;
            for(let i = 0; i < BASE_CONFIG.limit; i++) {
                state = algo.process(state, BASE_CONFIG).newState;
            }

            const res = algo.process(state, BASE_CONFIG);
            expect(res.result.allowed).toBe(false);
        });

        it("works correctly with limit=1", () => {
            const config = { limit: 1, windowMs: 10_000, weight: 1 };
            const first = algo.process(null, config);
            expect(first.result.allowed).toBe(true);
            expect(first.result.remaining).toBe(0);
            expect(algo.process(first.newState, config).result.allowed).toBe(false);
        });
    });

    describe("Remaining & limits", () => {
        it("remaining decrements correctly", () => {
            let state = null;
            for(let i = 0; i < BASE_CONFIG.limit; i++) {
                const res = algo.process(state, BASE_CONFIG);
                expect(res.result.remaining).toBe(BASE_CONFIG.limit - i - 1);
                state = res.newState;
            }
        });

        it("remaining never goes negative", () => {
            let state = exhaust(null);
            
            // file 5 more denied requests
            for(let i = 0; i < 5; i++) {
                const res = algo.process(state, BASE_CONFIG);
                expect(res.result.remaining).toBeGreaterThanOrEqual(0);
                state = res.newState;
            }
        });

        it("remaining stays at 0 after multiple denials", () => {
            let state = exhaust(null);
            for(let i = 0; i < 3; i++) {
                const res = algo.process(state, BASE_CONFIG);
                expect(res.result.remaining).toBe(0);
                state = res.newState;
            }
        });

        it("remaining is accurate mid-window", () => {
            const config = { limit: 10, windowMs: 10_000, weight: 1 };
            let state = null;

            for(let i = 0; i < 6; i++) {
                state = algo.process(state, config).newState;
            }

            expect(algo.process(state, config).result.remaining).toBe(3);
        });

        it("result.limit always matches config.limit", () => {
            const res = algo.process(null, BASE_CONFIG);
            expect(res.result.limit).toBe(BASE_CONFIG.limit);
        });
    });

    describe("retryAfter & retryReset", () => {
        it("retryAfter is undefined when allowed", () => {
            let state = null;

            for(let i = 0; i < BASE_CONFIG.limit; i++) {
                const res = algo.process(state, BASE_CONFIG);
                expect(res.result.retryAfter).toBeUndefined();
                state = res.newState;
            }
        });

        it("retry after is defined and positive when denied", () => {
            const state = exhaust(null);
            const res = algo.process(state, BASE_CONFIG);
            expect(res.result.retryAfter).toBeDefined();
            expect(res.result.retryAfter).toBeGreaterThan(0);
        });

        it("retryAfter is undefined on first request", () => {
            expect(algo.process(null, BASE_CONFIG).result.retryAfter).toBeUndefined();
        });

        it("retryAfter decreases as time advances", () => {
            const state = exhaust(null);
            const retryAfter1 = algo.process(state, BASE_CONFIG).result.retryAfter!;
            advanceTime(1000);
            const retryAfter2 = algo.process(state, BASE_CONFIG).result.retryAfter!;
            expect(retryAfter2).toBeLessThanOrEqual(retryAfter1);
        });

        it("resetTime is always >= now", () => {
            let state = null;
            for(let i = 0; i <= BASE_CONFIG.limit; i++) {
                const res = algo.process(state, BASE_CONFIG);
                expect(res.result.resetTime).toBeGreaterThanOrEqual(Date.now());
            }
        });
    });

    describe("Weight", () => {
        it("respects weight > 1", () => {
            const config = { limit: 10, windowMs: 10_000, weight: 3 };
            let state = null;
            for(let i = 0; i < 3; i++) {
                state = algo.process(state, config).newState;
            }

            expect(algo.process(state, config).result.allowed).toBe(false);
        });

        it("allows single request when weight equals limit", () => {
            const config = { limit: 5, windowMs: 10_000, weight: 5 };
            expect(algo.process(null, config).result.allowed).toBe(true);
        });

        it("denies first request when weight exceeds limit", () => {
            const config = { limit: 5, windowMs: 10_000, weight: 6 };
            expect(algo.process(null, config).result.allowed).toBe(false);
        });
    });

    describe("State continuity", () => {
        it("newState is never null or undefined", () => {
            expect(algo.process(null, BASE_CONFIG).newState).toBeDefined();
        });

        it("state has correct shape", () => {
            const state = algo.process(null, BASE_CONFIG).newState;
            expect(state).toHaveProperty("type");
            expect(state).toHaveProperty("data");
            expect(state).toHaveProperty("ttl");
        });

        it("TTL is always finite and positive", () => {
            let state = null;
            for(let i = 0; i < BASE_CONFIG.limit; i++) {
                const res = algo.process(state, BASE_CONFIG);
                expect(res.newState.ttl).toBeGreaterThan(0);
                expect(Number.isFinite(res.newState.ttl)).toBe(true);
                state = res.newState;
            }
        });

        it("denied request does not corrupt state", () => {
            const state = exhaust(null);
            const before = JSON.stringify(state);
            algo.process(state, BASE_CONFIG);
            expect(JSON.stringify(state)).toBe(before);
        });

        it("state after denial is usable for next request", () => {
            const state = exhaust(null);
            const denied = algo.process(state, BASE_CONFIG);
            expect(() => algo.process(denied.newState, BASE_CONFIG)).not.toThrow();
        });
    });

    describe("Time based reset", () => {
        it("allows requests after window expires", () => {
            if(options.skipHardResetTests) {
                return;
            }

            let state = exhaust(null);
            expect(algo.process(state, BASE_CONFIG).result.allowed).toBe(false);
            advanceTime(BASE_CONFIG.windowMs + 1);
            expect(algo.process(state, BASE_CONFIG).result.allowed).toBe(true);
        });

        it("partially refills within window", () => {
            const state = exhaust(null);
            advanceTime(BASE_CONFIG.windowMs / 2);
            const res = algo.process(state, BASE_CONFIG);
            expect(res.newState).toBeDefined();
            expect(res.result.remaining).toBeGreaterThanOrEqual(0);
            expect(res.result.remaining).toBeLessThanOrEqual(BASE_CONFIG.limit);
        });

        it("resets correctly across multiple windows", () => {
            if(options.skipHardResetTests) {
                return;
            }
            
            let state = exhaust(null);
            for(let w = 0; w < 3; w++) {
                advanceTime(BASE_CONFIG.windowMs + 1);
                const res = algo.process(state, BASE_CONFIG);
                expect(res.result.allowed).toBe(true);
                state = res.newState;
            }
        });
    });

    describe("Performance", () => {
        it("handles 1000 requests without performance issues", () => {
            const config = { limit: 10_000, windowMs: 60_000, weight: 1 };
            const start = performance.now();
            let state = null;

            for(let i = 0; i < 1000; i++) {
                state = algo.process(state, config).newState;
            }

            expect(performance.now() - start).lessThan(100);
        });
    });
};