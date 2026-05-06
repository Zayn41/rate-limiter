import { TokenBucketAlgorithm } from "../../algorithms/tokenBucket";
import { describe, it, afterEach, beforeEach, expect } from "vitest";
import { runCommonTests } from "../shared/commonTests";
import { advanceTime, setupMockTime, resetTime } from "../utils/mockTime";

const BASE_TIME = 1_700_000_000_000;
const BASE_CONFIG = { limit: 5, windowMs: 10_000, weight: 1 };

/**
 * Tests Token Bucket rate-limiting algorithm behavior:
 * - validates shared behavior via common test suite
 * - ensures token-based burst control with smooth refill logic
 * - verifies proportional refill over time (not step-based)
 * - checks capacity limits, retry timing, and edge-case stability
*/
describe("Token Bucket Algorithm", ()  => {
    // This test is shared across other algorithms 
    runCommonTests(() => new TokenBucketAlgorithm());

    // Algorithm specific tests
    describe("Token Bucket specific", () => {
        let algo: TokenBucketAlgorithm;

        beforeEach(() => {
            setupMockTime(BASE_TIME);
            algo = new TokenBucketAlgorithm();
        });

        afterEach(() => {
            resetTime();
        });

        const exhaust = (config = BASE_CONFIG) => {
            let state = null;

            for(let i = 0; i < config.limit; i++) {
                state = algo.process(state, BASE_CONFIG).newState;
            }

            return state;
        };

        /**
         * Validates token refill mechanics over time:
         * - tokens regenerate gradually based on elapsed time
         * - partial refill is proportional, not discrete
         * - refill behavior remains smooth under varying time gaps
         * - ensures bucket never exceeds configured capacity
        */
        describe("Token refill", () => {
            it("refills token overtime", () => {
                let state = exhaust();
                expect(algo.process(state, BASE_CONFIG).result.allowed).toBe(false);

                // 1 token = windowMs / limit = 10000 / 5 = 2000ms
                advanceTime(2000);
                expect(algo.process(state, BASE_CONFIG).result.allowed).toBe(true);
            });

            it("partially refills proportionally", () => {
                const config = { limit: 10, windowMs: 10_000, weight: 1 };
                let state = exhaust(config);

                // 3 tokens = 3000ms at rate 10/10000
                advanceTime(3000);

                for(let i = 0 ; i < 3; i++) {
                    const res = algo.process(state, config);
                    expect(res.result.allowed).toBe(true);
                    state = res.newState;
                }

                const final = algo.process(state, config);
                expect(final.result.allowed).toBe(false);
            });

            it("refills smoothly not in steps", () => {
                let state = exhaust();

                advanceTime(1000); // half a token

                expect(algo.process(state, BASE_CONFIG).result.allowed).toBe(false);

                advanceTime(1000); // full token now
                expect(algo.process(state, BASE_CONFIG).result.allowed).toBe(true);
            });

            it("does not exceed bucket capacity after long idle", () => {
                advanceTime(100_000);
                const res = algo.process(null, BASE_CONFIG);
                expect(res.result.remaining).toBe(BASE_CONFIG.limit - 1);
                expect((res.newState.data as any).tokens).toBeLessThanOrEqual(BASE_CONFIG.limit);
            });

            it("lastRefill does not advance when not time passes", () => {
                let state = exhaust();
                const lastRefillBefore = (state?.data as any).lastRefill;

                const denied = algo.process(state, BASE_CONFIG);
                expect(denied.result.allowed).toBe(false);
                expect((denied.newState.data as any).lastRefill).toBe(lastRefillBefore);
            });
        });

        /**
         * Validates burst handling characteristics of token bucket:
         * - allows immediate consumption of available tokens (burst behavior)
         * - ensures strict enforcement once bucket is empty
         * - verifies weighted consumption reduces tokens correctly
        */
        describe("Burst capacity", () => {
            it("allows full burst from full bucket", () => {
                const config = { limit: 10, windowMs: 10_000, weight: 1 };
                let state = null;

                for(let i = 0; i < config.limit; i++) {
                    const res = algo.process(state, config);
                    expect(res.result.allowed).toBe(true);
                    state = res.newState;
                }

                const final = algo.process(state, config);
                expect(final.result.allowed).toBe(false);
            });

            it("weight > 1 consumes correct tokens", () => {
                const config = { limit: 10, windowMs: 10_000, weight: 3 };
                const res = algo.process(null, config);
                expect(res.result.allowed).toBe(true);
                expect(res.result.remaining).toBe(7);
            });
        });

        /**
         * Ensures correctness of retry timing calculation:
         * - retryAfter reflects exact refill time required
         * - validates synchronization between token regeneration and time
         * - ensures consumer can accurately predict next available request window
        */
        describe("retryAfter accuracy", () => {
            it("retryAfter matches exact refill time", () => {
                let state = exhaust();

                const retryAfter = algo.process(state, BASE_CONFIG).result.retryAfter!;

                advanceTime(retryAfter * 1000);
                expect(algo.process(state, BASE_CONFIG).result.allowed).toBe(true);
            });
        });

        /**
         * Validates resilience under unusual system conditions:
         * - handles system clock moving backwards (clock skew)
         * - ensures no negative tokens or state corruption
         * - guarantees stability under time anomalies
        */
        describe("Edge cases", () => {
            it("handles clock skew gracefully", () => {
                const res1 = algo.process(null, BASE_CONFIG);
                setupMockTime(BASE_TIME - 100); // clock goes backwards

                expect(() => {
                    const res2 = algo.process(res1.newState, BASE_CONFIG);
                    expect((res2.newState.data as any).tokens).toBeGreaterThanOrEqual(0);
                }).not.toThrow();
            });
        });
    });
});