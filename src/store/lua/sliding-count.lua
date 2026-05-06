---@diagnostic disable: undefined-global
-- Sliding Window Count Lua Script

local key = KEYS[1] -- key
local limit = tonumber(ARGV[1]) -- limit
local windowMS = tonumber(ARGV[2]) -- windowMS
local weight = tonumber(ARGV[3]) -- weight
local now = tonumber(ARGV[4]) -- now

-- Current window start
local windowStart = math.floor(now / windowMS) * windowMS
local windowEnd = windowStart + windowMS
local ttl = math.max(1, (windowEnd - now) + windowMS)

-- Get store state
local raw = redis.call("GET", key)
local currentCount = 0
local previousCount = 0
local storedStart = 0

if raw then
    local data = cjson.decode(raw)
    currentCount = tonumber(data.currentCount) or 0
    previousCount = tonumber(data.previousCount) or 0
    storedStart = tonumber(data.windowStart) or 0
end

-- Handle window rollover
if windowStart > storedStart + windowMS then
    -- Double rollover — reset both
    currentCount = 0
    previousCount = 0
elseif windowStart > storedStart then
    -- Single rollover — shift counts   
    previousCount = currentCount
    currentCount = 0
end

-- Calculate effective count
local elapsed = now - windowStart
local previousWeight = (windowMS - elapsed) / windowMS
local effectiveCount = (previousCount * previousWeight) + currentCount

-- Check if allowed 
local allowed = (effectiveCount + weight) <= limit

if allowed then
    currentCount = currentCount + weight
end

-- Store new state
local newState = cjson.encode({
    currentCount = currentCount,
    previousCount = previousCount,
    windowStart = windowStart,
    ttl = ttl
})

redis.call("SET", key, newState, "PX", ttl)

-- Build result
local effectiveAfter = allowed and (effectiveCount + weight) or effectiveCount
local remaining = math.max(0, math.floor(limit - effectiveAfter))
local retryAfter = 0

if not allowed then
    retryAfter = math.ceil(ttl / 1000)
end

return {
    allowed and 1 or 0,
    remaining,
    limit,
    windowEnd,
    retryAfter
}