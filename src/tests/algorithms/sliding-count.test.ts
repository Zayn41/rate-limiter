import { SlidingWindowCountAlgorithm } from "../../algorithms/slidingWindow";
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { runCommonTests } from "../shared/commonTests";
import { advanceTime, setupMockTime, resetTime } from "../utils/mockTime";

const BASE_TIME = 1_700_000_000_000;
const BASE_CONFIG = { limit: 5, windowMs: 10_000, weight: 1 };

/**
 * Tests Sliding Window Count rate-limiting algorithm behavior:
 * - validates shared behavior through common test suite
 * - ensures smooth sliding-window based rate calculation
 * - verifies weighted historical + current window blending
 * - confirms correct approximation and boundary behavior
 */
describe("Sliding Window Count Algorithm", () => {
    // This test is shared across other algorithms 
    runCommonTests(() => new SlidingWindowCountAlgorithm(), { skipHardResetTests: true });

    // Algorithm specific test
    describe("Slding Window Count specific", () => {
        let algo: SlidingWindowCountAlgorithm;

        beforeEach(() => {
            setupMockTime(BASE_TIME);
            algo = new SlidingWindowCountAlgorithm();
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
         * Validates sliding window transition logic:
         * - ensures gradual decay of previous window influence
         * - verifies correct behavior across partial and full window rollovers
         * - confirms proper blending of previous and current window counts
         * - documents multi-window reset and carry-over semantics
        */
        describe("Window behaviour", () => {
            it("full resets after two windows — by design", () => {
                let state = exhaust();

                expect(algo.process(state, BASE_CONFIG).result.allowed).toBe(false);

                // One window — still partially blocked (previous weight ~1.0)
                advanceTime(BASE_CONFIG.windowMs + 1);
                // Two windows — double rollover, fully reset
                advanceTime(BASE_CONFIG.windowMs);
                expect(algo.process(state, BASE_CONFIG).result.allowed).toBe(true);
            });

            it("gradually allows more requests as window slides", () => {
                let state = exhaust();

                // At 50% into new window, previous carries 50% weight
                // effectiveCount = 5 × 0.5 = 2.5, so 2 more requests allowed
                advanceTime(BASE_CONFIG.windowMs + BASE_CONFIG.windowMs * 0.5);
                const res = algo.process(state, BASE_CONFIG);
                expect(res.result.allowed).toBe(true);
            });

            it("single rollover carries previous count correctly", () => {
                const config = { limit: 10, windowMs: 10_000, weight: 1 };
                let state = null;

                for (let i = 0; i < 6; i++) {
                    state = algo.process(state, config).newState;
                }

                // 50% into new window → effectiveCount = 6 × 0.5 = 3
                advanceTime(config.windowMs + config.windowMs * 0.5);

                const res = algo.process(state, config);
                expect(res.result.allowed).toBe(true);
                // effectiveAfter = 3 + 1 = 4, remaining = 10 - 4 = 6
                expect(res.result.remaining).toBe(6);
            });

            it("double rollover resets both counts to zero", () => {
                let state = exhaust();
                advanceTime(BASE_CONFIG.windowMs * 2 + 1);

                const res = algo.process(state, BASE_CONFIG);
                expect(res.result.allowed).toBe(true);
                expect(res.result.remaining).toBe(BASE_CONFIG.limit - 1);
                expect((res.newState.data as any).previousCount).toBe(0);
                expect((res.newState.data as any).currentCount).toBe(1);
            });

            it("single rollover moves currentCount to previousCount", () => {
                let state = null;

                for(let i = 0; i < 4; i++) {
                    state = algo.process(state, BASE_CONFIG).newState;
                }

                const currentCount = (state?.data as any).currentCount; // currentCount = 4

                advanceTime(BASE_CONFIG.windowMs + 1);

                const res = algo.process(state, BASE_CONFIG);
                expect((res.newState.data as any).previousCount).toBe(currentCount);
                expect((res.newState.data as any).currentCount).toBe(1);
            });

            it("windowStart updates and stays aligned after rollover", () => {
                let state = algo.process(null, BASE_CONFIG).newState;
                const windowStartBefore = (state.data as any).windowStart;

                advanceTime(BASE_CONFIG.windowMs + 1);

                const res = algo.process(state, BASE_CONFIG);
                const windowStartAfter = (res.newState.data as any).windowStart;

                expect(windowStartAfter).toBeGreaterThan(windowStartBefore);
                expect(windowStartAfter % BASE_CONFIG.windowMs).toBe(0);
            });
        });

        /**
         * Ensures correctness of request counting in sliding window:
         * - currentCount increments only on allowed requests
         * - denied requests do not modify state
         * - weight is properly applied to request count
         * - validates approximation accuracy within acceptable margin
        */
        describe("Count accuracy", () => {
            it("currentCount increments on each allowed requests", () => {
                let state = null;

                for(let i = 0; i < BASE_CONFIG.limit; i++) {
                    const res = algo.process(state, BASE_CONFIG);
                    expect((res.newState.data as any).currentCount).toBe(i + 1);
                    state = res.newState;
                }
            });

            it("denied request does not increment currentCount", () => {
                let state = exhaust();
                const currentBefore = (state?.data as any).currentCount;

                const denied = algo.process(state, BASE_CONFIG);
                expect(denied.result.allowed).toBe(false);
                expect((denied.newState.data as any).currentCount).toBe(currentBefore);
            });

            it("weight > 1 adds to currentCount correctly", () => {
                const config = { limit: 10, windowMs: 10_000, weight: 3 };
                const res = algo.process(null, config);

                expect(res.result.allowed).toBe(true);
                expect((res.newState.data as any).currentCount).toBe(3);
                expect(res.result.remaining).toBe(7);
            });

            it("approximation stays within acceptable margin", () => {
                const config = { limit: 100, windowMs: 10_000, weight: 1 };
                let state = null;

                for(let i = 0; i < 80; i++) {
                    state = algo.process(state, config).newState;
                }

                // 30% into new window → effectiveCount = 80 × 0.7 = 56
                advanceTime(config.windowMs + config.windowMs * 0.3);

                const res = algo.process(state, config);

                // remaining ≈ 100 - 56 - 1 = 43, allow ±5% margin
                expect(res.result.remaining).toBeGreaterThanOrEqual(40);
                expect(res.result.remaining).toBeLessThanOrEqual(46);
            });
        });
    });
});