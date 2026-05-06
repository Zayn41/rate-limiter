import { vi } from "vitest";

/**
 * Initializes fake timers and sets the starting system time.
 *
 * 🧪 Use this at the beginning of tests that depend on time
 * (e.g. rate limiting windows, TTL expiration).
 *
 * @param start - Initial timestamp in milliseconds (default: 0)
 *
 * @example
 * setupMockTime(Date.now());
*/
export const setupMockTime = (start = 0) => {
    vi.useFakeTimers();
    vi.setSystemTime(start);
};

/**
 * Advances the mocked time forward by a given duration.
 *
 * This simulates time passing without waiting in real-time.
 *
 * @param ms - Milliseconds to advance
 *
 * @example
 * advanceTime(1000); // move forward by 1 second
*/
export const advanceTime = (ms: number) => {
    vi.advanceTimersByTime(ms);
};

/**
 * Sets the mocked system time to a specific timestamp.
 *
 * Useful for jumping to an exact moment in time.
 *
 * @param ms - Target timestamp in milliseconds
 *
 * @example
 * setTime(Date.now() + 5000);
*/
export const setTime = (ms: number) => {
    vi.setSystemTime(ms);
};

/**
 * Restores real timers and disables mocking.
 *
 * ⚠️ Always call this after tests using fake timers
 * to avoid side effects across test suites.
 *
 * @example
 * afterEach(() => resetTime());
 */
export const resetTime = () => {
    vi.useRealTimers();
};