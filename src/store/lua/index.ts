import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);

const __dirname = dirname(__filename);

const luaDir = existsSync(join(__dirname, "lua")) ? join(__dirname, "lua") : __dirname;

/**
 * Preloaded Redis Lua script for the Token Bucket algorithm.
 *
 * This script implements atomic rate limiting using Redis EVAL/EVALSHA.
 * It ensures consistent token refill and consumption without race conditions.
 *
 * Loaded as a UTF-8 string and executed via RedisStore.
*/
export const TOKEN_BUCKET_SCRIPT = readFileSync(join(luaDir, "token-bucket.lua"), "utf-8");

/**
 * Preloaded Redis Lua script for the Fixed Window algorithm.
 *
 * Implements a simple counter-based rate limit within a fixed time window.
 * Uses atomic operations to prevent race conditions.
*/
export const FIXED_WINDOW_SCRIPT = readFileSync(join(luaDir, "fixed-window.lua"), "utf-8");

/**
 * Preloaded Redis Lua script for the Sliding Window Log algorithm.
 *
 * Uses Redis Sorted Sets (ZSET) to track request timestamps.
 * Provides precise rate limiting by storing individual request events.
*/
export const SLIDING_LOG_SCRIPT = readFileSync(join(luaDir, "sliding-log.lua"), "utf-8");

/**
 * Preloaded Redis Lua script for the Sliding Window Counter algorithm.
 *
 * Uses a hybrid approach (buckets + weighting) to approximate
 * sliding window behavior with better performance than full logs.
*/
export const SLIDING_COUNT_SCRIPT = readFileSync(join(luaDir, "sliding-count.lua"), "utf-8");