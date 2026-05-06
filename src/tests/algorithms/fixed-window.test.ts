import { runCommonTests } from "../shared/commonTests";
import { FixedWindowAlgorithm } from "../../algorithms/fixedWindow";
import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { setupMockTime, advanceTime, resetTime } from "../utils/mockTime";
import type { RateLimitState } from "../../types/state";

const BASE_TIME = 1_700_000_000_000;
const BASE_CONFIG = { limit: 5, windowMs: 10_000, weight: 1 };

/**
 * Tests Fixed Window rate-limiting algorithm behavior:
 * - verifies shared behavior via common test suite
 * - validates fixed-window-specific semantics like reset boundaries
 * - ensures count, TTL, and window alignment correctness
 * - documents known limitation: boundary burst behavior
*/
describe("Fixed Window Algorithm", () => {
    // This test is shared across other algorithms 
    runCommonTests(() => new FixedWindowAlgorithm());

    describe("Fixed Window specific", () => {
        let algo: FixedWindowAlgorithm;

        beforeEach(() => {
            setupMockTime(BASE_TIME);
            algo = new FixedWindowAlgorithm();
        });

        afterEach(() => {
            resetTime();
        });

        /**
         * Validates fixed window lifecycle behavior:
         * - counter resets after window boundary is crossed
         * - windowStart aligns correctly to windowMs boundaries
         * - TTL decreases as time progresses within a window
         * - ensures each window operates in full isolation
        */
        describe("Window boundary", () => {
            it("resets counter at window boundary", () => {
                let state = null;

                for(let i = 0; i < BASE_CONFIG.limit; i++) {
                    state = algo.process(state, BASE_CONFIG).newState;
                }

                advanceTime(BASE_CONFIG.windowMs + 1);

                // Old state passed — algorithm detects new window via windowStart change
                const res = algo.process(state, BASE_CONFIG);
                expect(res.result.allowed).toBe(true);
                expect(res.result.remaining).toBe(BASE_CONFIG.limit - 1);
            });

            it("window start is aligned to windowMs boundary", () => {
                advanceTime(3_500);
                const res = algo.process(null, BASE_CONFIG);
                const windowStart = (res.newState.data as any).windowStart;
                expect(windowStart % BASE_CONFIG.windowMs).toBe(0)
            });

            it("TTL decreases as window progress", () => {
                const res1 = algo.process(null, BASE_CONFIG);
                advanceTime(2000);
                const res2 = algo.process(res1.newState, BASE_CONFIG);
                expect(res2.newState.ttl).toBeLessThan(res1.newState.ttl);
            });

            it("each window is fully isolated", () => {
                let state: RateLimitState | null = null;

                for(let w = 0; w < 3; w++) {
                    let windowState: RateLimitState | null = state;

                    for(let i = 0; i < BASE_CONFIG.limit; i++) {
                        const res = algo.process(windowState, BASE_CONFIG);
                        expect(res.result.allowed).toBe(true);
                        windowState = res.newState;
                    }

                    expect(algo.process(windowState, BASE_CONFIG).result.allowed).toBe(false);
                    advanceTime(BASE_CONFIG.windowMs + 1);
                    state = windowState;
                }
            });
        });

        /**
         * Ensures request counting correctness within a fixed window:
         * - count increments correctly per allowed request
         * - denied requests do not modify state
         * - weight is correctly applied to count and remaining quota
        */
        describe("Count accuracy", () => {
            it("accumulates count within same window", () => {
                let state = null;

                for(let i = 0; i < BASE_CONFIG.limit; i++) {
                    const res = algo.process(state, BASE_CONFIG);
                    expect((res.newState.data as any).count).toBe(i + 1);
                    state = res.newState;
                }
            });

            it("denied request does not increament count", () => {
                let state = null;

                for(let i = 0; i < BASE_CONFIG.limit; i++) {
                    state = algo.process(state, BASE_CONFIG).newState;
                }

                const countBefore = (state?.data as any).count;

                for(let w = 0; w < 3; w++) {
                    const res = algo.process(state, BASE_CONFIG);
                    expect(res.result.allowed).toBe(false);
                    expect((res.newState.data as any).count).toBe(countBefore);
                    state = res.newState;
                }
            });

            it("weight > 1 increments count correctly", () => {
                const config = { limit: 10, windowMs: 10_000, weight: 3 };
                const res = algo.process(null, config);
                expect((res.newState.data as any).count).toBe(3);
                expect(res.result.remaining).toBe(7);
            });
        });

        /**
         * Documents and validates fixed-window burst behavior:
         * - demonstrates edge-case where limits can be exceeded across boundary
         * - confirms expected "burst allowance" at window transitions
         * - serves as a known trade-off of fixed window algorithm design
        */
        describe("Boundary burst (known limitation)", () => {
            it("demonstrates 2x limit requests across window boundary", () => {
                let state = null;

                // Fill window right before boundary
                advanceTime(BASE_CONFIG.windowMs - 1);
                for(let i = 0; i < BASE_CONFIG.limit; i++) {
                    const res = algo.process(state, BASE_CONFIG);
                    expect(res.result.allowed).toBe(true);
                    state = res.newState;
                }

                // Cross boundary
                advanceTime(2);

                // Full limit again — proves burst
                let newState = null;
                for(let i = 0; i < BASE_CONFIG.limit; i++) {
                    const res = algo.process(newState, BASE_CONFIG);
                    expect(res.result.allowed).toBe(true);
                    newState = res.newState;
                }
                // 10 requests in 2ms — boundary burst documented
            });
        });
    });
});
