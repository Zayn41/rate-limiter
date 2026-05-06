import { SlidingWindowLogAlgorithm } from "../../algorithms/slidingWindow";
import { describe, it, afterEach, beforeEach, expect } from "vitest";
import { runCommonTests } from "../shared/commonTests";
import { setupMockTime, resetTime, advanceTime } from "../utils/mockTime";

const BASE_TIME = 1_700_000_000_000;
const BASE_CONFIG = { limit: 5, windowMs: 10_000, weight: 1 };

/**
 * Tests Sliding Window Log rate-limiting algorithm behavior:
 * - verifies shared behavior via common test suite
 * - ensures strict log-based sliding window correctness
 * - validates timestamp tracking and pruning logic
 * - confirms no burst behavior at window boundaries
*/
describe("Sliding Window Log Alogrithm", () => {
    // This test is shared across other algorithms 
    runCommonTests(() => new SlidingWindowLogAlgorithm());

    // Algorithm specific tests
    describe("Sliding Window Log specific", () => {
        let algo: SlidingWindowLogAlgorithm;

        beforeEach(() => {
            setupMockTime(BASE_TIME);
            algo = new SlidingWindowLogAlgorithm();
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
         * Validates strict correctness of sliding log algorithm:
         * - ensures no burst at window boundaries
         * - verifies accurate enforcement of rolling time window
         * - confirms behavior differs from fixed window strategy
        */
        describe("Accuracy", () => {
            it("is accurate at window boundaries — no burst", () => {
                let state = null;

                // Fill window 100ms before boundary
                advanceTime(BASE_CONFIG.windowMs - 100);
                for(let i = 0; i < BASE_CONFIG.limit; i++) {
                    const res = algo.process(state, BASE_CONFIG);
                    expect(res.result.allowed).toBe(true);
                    state = res.newState;
                }

                // Cross boundary by 200ms
                advanceTime(200);

                // Still denied — timestamps still inside rolling window
                expect(algo.process(state, BASE_CONFIG).result.allowed).toBe(false);
            });

            it("prevents boundary burst problem unlike fixed window", () => {
                let state = null;

                // Move near end of window
                advanceTime(BASE_CONFIG.windowMs - 100);

                for(let i = 0; i < BASE_CONFIG.limit; i++) {
                    state = algo.process(state, BASE_CONFIG).newState;
                }

                // Cross beyond
                advanceTime(200);

                // Fixed window would reset here — sliding log does not
                expect(algo.process(state, BASE_CONFIG).result.allowed).toBe(false);
            });
        });

        /**
         * Ensures correct timestamp tracking and cleanup:
         * - timestamps are stored per request accurately
         * - denied requests do not modify log state
         * - expired timestamps are properly pruned
         * - all timestamps remain within active window
         * - weight correctly influences log entries
        */
        describe("Timestamp management", () => {
            it("timestamp count grows with each allowes requests", () => {
                let state = null;
                for(let i = 0; i < BASE_CONFIG.limit; i++) {
                    const res = algo.process(state, BASE_CONFIG);
                    expect((res.newState.data as any).timestamps.length).toBe(i + 1);
                    state = res.newState;
                }
            });

            it("denied request should not add timestamp", () => {
                let state = exhaust();
                const countBefore = (state?.data as any).timestamps.length;

                const denied = algo.process(state, BASE_CONFIG);
                expect(denied.result.allowed).toBe(false);
                expect((denied.newState.data as any).timestamps.length).toBe(countBefore);
            });

            it("prunes expired timestamps correctly", () => {
                let state = exhaust();

                advanceTime(BASE_CONFIG.windowMs + 1);

                const res = algo.process(state, BASE_CONFIG);
                // old timestamps pruned + 1 new one added
                expect((res.newState.data as any).timestamps.length).toBe(1);
            });

            it("all stored timestamps are within current window", () => {
                let state = exhaust();
                advanceTime(BASE_CONFIG.windowMs + 1);
                
                const res = algo.process(state, BASE_CONFIG);
                const timestamps = (res.newState.data as any).timestamps as number[];
                const windowStart = Date.now() - BASE_CONFIG.windowMs;

                for(const ts of timestamps) {
                    expect(ts).toBeGreaterThanOrEqual(windowStart);
                }
            });

            it("weight > 1 pushess correct number of timestamps", () => {
                const config = { limit: 10_000, windowMs: 60, weight: 3 };
                const res = algo.process(null, config);
                expect((res.newState.data as any).timestamps.length).toBe(3);
            });
        });

        /**
         * Validates gradual recovery behavior of sliding log:
         * - capacity is regained progressively as timestamps expire
         * - ensures smooth request allowance over time
         * - verifies TTL decreases correctly as time advances
         */
        describe("Gradual recovery", () => {
            it("recovers one slot at a time as timestamps expire", () => {
                let state = null;
                const msPerToken = BASE_CONFIG.windowMs / BASE_CONFIG.limit;

                // Fill the window
                for(let i = 0; i < BASE_CONFIG.limit; i++) {
                    const res = algo.process(state, BASE_CONFIG);
                    state = res.newState;
                    advanceTime(msPerToken);
                }

                // Now test gradual recovery
                for(let i = 0; i < BASE_CONFIG.limit; i++) {
                    advanceTime(msPerToken + 1);
                    const res = algo.process(state, BASE_CONFIG);
                    expect(res.result.allowed).toBe(true);
                    state = res.newState;
                }
            });

            it("TTL decreases as time advance", () => {
                let state = exhaust();
                const ttlBefore = state?.ttl;

                advanceTime(1000);
                const res = algo.process(state, BASE_CONFIG);
                expect(res.newState.ttl).toBeLessThan(ttlBefore!);
            });
        });
    });
});