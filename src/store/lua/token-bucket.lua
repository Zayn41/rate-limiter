-- ---@diagnostic disable: undefined-global

local key = KEYS[1] -- key
local limit = tonumber(ARGV[1]) --[[@as number]] -- limit
local windowMs = tonumber(ARGV[2]) -- windowMS
local weight = tonumber(ARGV[3]) -- weight
local now = tonumber(ARGV[4]) -- now
local refillRate = limit / windowMs -- refillRate

-- Get stored state
local raw = redis.call("GET", key)
local tokens = limit -- full bucket by default
local lastRefill = now -- lastRefill 

if raw then
    local data = cjson.decode(raw)
    tokens = tonumber(data.tokens) or limit
    lastRefill = tonumber(data.lastRefill) or now
end

-- Refill tokens based on elapsed time
local delta = math.max(0, now - lastRefill)
local tokensToAdd = delta * refillRate
tokens = math.min(limit, tokens + tokensToAdd)

-- Check if allowed
local allowed = tokens >= weight;

if allowed then
    tokens = tokens - weight
    lastRefill = now
end

-- Calculate TTL
local missingTokens = limit - tokens
local ttl

if missingTokens <= 0 then
    ttl = windowMs
else
    ttl = math.max(1, math.ceil(missingTokens * (windowMs / limit)))
end

-- Store new state
local newState = cjson.encode({
    tokens = tokens,
    lastRefill = lastRefill,
    ttl = ttl
})

redis.call("SET", key, newState, "PX", ttl)

-- Build result
local remaining = math.max(0, math.floor(tokens))
local timeToFullMs = (limit - tokens) / refillRate
local resetTime = now + math.ceil(timeToFullMs)
local retryAfter = 0

if not allowed then
    local tokenNeeded = math.max(0, weight - tokens)
    local timeUntilAllowed = tokenNeeded / refillRate
    retryAfter = math.ceil(timeUntilAllowed / 1000)
end

return {
    allowed and 1 or 0,
    remaining,
    limit,
    resetTime,
    retryAfter
}