---@diagnostic disable: undefined-global

local key = KEYS[1] -- key
local limit = tonumber(ARGV[1]) -- limit
local windowMS = tonumber(ARGV[2]) -- windowMS
local weight = tonumber(ARGV[3]) -- weight
local now = tonumber(ARGV[4]) -- now

-- Calculate current window start
local windowStart = math.floor(now / windowMS) * windowMS;
local windowEnd = windowStart + windowMS;
local ttl = math.max(1, windowEnd - now);

-- Get stored state
local raw = redis.call("GET", key);
local count = 0;
local storedStart = 0;

if raw then
    local data = cjson.decode(raw);
    count = data.count or 0;
    storedStart = data.windowStart or 0;
end

-- New window — reset count
if storedStart ~= windowStart then
    count = 0;
end

-- Check if allowed
local allowed = (count + weight) <= limit;

if allowed then
    count = count + weight;
end

-- Store new state
local newState = cjson.encode({
    count = count,
    windowStart = windowStart,
    ttl = ttl
});

redis.call("SET", key, newState, "PX", ttl);

-- Build result
local remaining = math.max(0, limit - count);
local retryAfter = 0;

if not allowed then
    retryAfter = math.ceil(ttl / 1000);
end

return {
    allowed and 1 or 0, -- [1] allowed (1=true, 0=false)
    remaining, -- [2] remaining
    limit, -- [3] limit
    windowEnd, -- [4] resetTime
    retryAfter -- [5] retryAfter (0 = not set)
};