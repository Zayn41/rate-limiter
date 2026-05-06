-- LuaLS will show "undefined global" warnings

-- ✅ Add to redis.d.lua
---@meta

---@class RedisLib
---@field call fun(command: string, ...: any): any
---@field pcall fun(command: string, ...: any): any
---@field log fun(level: number, message: string)

---@type RedisLib
redis = _G.redis

---@type string[]
KEYS = {}

---@type string[]
ARGV = {}

-- cjson built into Redis
---@class cjson
---@field encode fun(value: any): string
---@field decode fun(str: string): any
cjson = {}

-- math extensions
---@type { floor: fun(n: number): number, ceil: fun(n: number): number, max: fun(...): number, min: fun(...): number }
math = {}