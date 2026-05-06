---@diagnostic disable: undefined-global

-- Sliding Window Log Lua Script
-- Uses Redis Sorted Set (ZSET) for O(log n) timestamp management

local key = KEYS[1] -- key
local limit = tonumber(ARGV[1]) -- limit
local windowMs = tonumber(ARGV[2]) -- windowMs
local weight = tonumber(ARGV[3]) -- weight
local now = tonumber(ARGV[4]) -- now

-- calculate window boundary
local windowStart = now - windowMs

-- removed expired entries
redis.call("ZREMRANGEBYSCORE", key, "-inf", windowStart)

-- count valid requests in window
local currentCount = redis.call("ZCARD", key)

-- check if allowed
local allowed = (currentCount + weight) <= limit

-- add new timestamps if allowed
if allowed then
    local rand = tostring(math.random(100000, 999999))
    for i = 1, weight do
        redis.call("ZADD", key, now, now .. ":" .. i .. ":" .. rand)
    end
    currentCount = currentCount + weight
end

-- set TTL — key expires after one full window of inactivity
redis.call("PEXPIRE", key, windowMs)

local retryAfter = 0

if not allowed then
    local needed = (currentCount + weight) - limit

    -- get the nth oldest timestamp — when it expires, weight slots free up
    local nthOldest = redis.call("ZRANGE", key, needed - 1, needed - 1)

    if #nthOldest > 0 then
        local oldestScore  = tonumber(string.match(nthOldest[1], "^(%d+)"))
        local msUntilFree = (oldestScore + windowMs) - now
        retryAfter = math.ceil(math.max(0, msUntilFree) / 1000)
    else
        retryAfter = math.ceil(windowMs / 1000)
    end
end

-- build restult
local remaining = math.max(0, limit - currentCount)
local resetTime = now + windowMs -- default approximate

-- Get oldest entry for accurate resetTime
local oldest = redis.call("ZRANGE", key, 0, 0)

if #oldest > 0 then
    local oldestScore = tonumber(string.match(oldest[1], "^(%d+)"))
    resetTime = oldestScore + windowMs
end

return {
    allowed and 1 or 0, -- [1] allowed
    remaining,           -- [2] remaining
    limit,               -- [3] limit
    resetTime,           -- [4] resetTime
    retryAfter           -- [5] retryAfter
}