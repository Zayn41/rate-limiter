# nexus-limiter

<div align="center">

![npm version](https://img.shields.io/npm/v/nexus-limiter)
![npm downloads](https://img.shields.io/npm/dm/nexus-limiter)
![license](https://img.shields.io/npm/l/nexus-limiter)
![build](https://github.com/Zayn41/rate-limiter/actions/workflows/ci.yml/badge.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-First-blue)

**Production-ready rate limiting for Node.js**

Token bucket · Fixed window · Sliding window · Redis · In-memory · Express · Fastify · NestJS · Hono

</div>

---

## Why nexus-limiter?

Most rate limiters give you one algorithm and call it done. nexus-limiter gives you four — and lets you swap between them without changing your application code.

| Feature | nexus-limiter | express-rate-limit |
|---|---|---|
| Native TypeScript | ✅ | ❌ bolted on |
| Token bucket (default) | ✅ | ❌ |
| Sliding window (accurate) | ✅ | ❌ |
| Sliding window (counter) | ✅ | ❌ |
| Fixed window | ✅ | ✅ |
| Weight per request | ✅ | ❌ |
| Plugin system | ✅ | ❌ |
| O(1) LRU memory store | ✅ | ❌ |
| Redis atomic Lua scripts | ✅ | via plugin |
| Express | ✅ | ✅ |
| Fastify | ✅ | ❌ |
| NestJS | ✅ | ❌ |
| Hono | ✅ | ❌ |

---

## Installation

```bash
npm install nexus-limiter
```

### Optional peer dependencies

Install only what you need:

```bash
# Redis store
npm install ioredis

# Framework adapters — install your framework
npm install express
npm install fastify
npm install hono
```

---

## Quick start

```typescript
import { RateLimiter, MemoryStore } from "nexus-limiter";
import { expressRateLimiter } from "nexus-limiter/middleware/express";
import express from "express";

const app = express();

const limiter = new RateLimiter({
  store:     new MemoryStore(),
  limit:     100,        // 100 requests
  windowMs:  60_000,     // per minute
});

app.use(expressRateLimiter(limiter));

app.get("/", (req, res) => {
  res.json({ message: "Hello!" });
});
```

---

## Algorithms

nexus-limiter supports four rate limiting algorithms. Choose based on your use case.

### Token Bucket (default)

Tokens refill continuously at a fixed rate. Allows bursting up to the bucket capacity.

```typescript
import { RateLimiter, MemoryStore, Algorithm } from "nexus-limiter";

const limiter = new RateLimiter({
  store:     new MemoryStore(),
  limit:     100,       // bucket capacity
  windowMs:  60_000,    // full refill time
  algorithm: Algorithm.TOKEN,
});
```

**Best for:** APIs where occasional bursts are acceptable. Smoothest request handling.

---

### Fixed Window

Counts requests in fixed time windows. Resets at window boundaries.

```typescript
const limiter = new RateLimiter({
  store:     new MemoryStore(),
  limit:     100,
  windowMs:  60_000,
  algorithm: Algorithm.FIXED,
});
```

**Best for:** Simple use cases. Lowest memory usage.  
**Note:** Allows up to 2× limit at window boundaries (boundary burst).

---

### Sliding Window Log

Tracks individual request timestamps. Accurate to the millisecond.

```typescript
const limiter = new RateLimiter({
  store:     new MemoryStore(),
  limit:     100,
  windowMs:  60_000,
  algorithm: Algorithm.SLIDING_LOG,
});
```

**Best for:** Strict accuracy requirements. No boundary burst.  
**Note:** Memory usage scales with limit size.

---

### Sliding Window Counter

Approximates sliding window using two fixed-window counters. O(1) memory.

```typescript
const limiter = new RateLimiter({
  store:     new MemoryStore(),
  limit:     100,
  windowMs:  60_000,
  algorithm: Algorithm.SLIDING_COUNT,
});
```

**Best for:** High-scale deployments. ~99% accuracy at O(1) memory.

---

## Stores

### Memory Store (default)

In-process store with LRU eviction. No external dependencies.

```typescript
import { MemoryStore } from "nexus-limiter";

const store = new MemoryStore(
  60_000,   // cleanup interval (ms) — default 60s
  10_000    // max entries before LRU eviction — default 10,000
);
```

**Best for:** Single-process applications, development, testing.  
**Note:** Does not share state across multiple processes or servers.

---

### Redis Store

Distributed store with atomic Lua scripts. Prevents race conditions under concurrency.

```typescript
import { RedisStore } from "nexus-limiter";

// Using URL
const store = new RedisStore({
  url: "redis://:password@localhost:6379",
});

// Using options
const store = new RedisStore({
  host:     "localhost",
  port:     6379,
  password: process.env.REDIS_PASSWORD,
  prefix:   "rl:",  // key prefix — default "rl:"
});

// Inject existing client
import Redis from "ioredis";
const client = new Redis({ host: "localhost" });
const store  = new RedisStore({ client });
```

**Best for:** Multi-process, multi-server deployments.  
**Requires:** `npm install ioredis`

---

## Framework adapters

### Express

```typescript
import { expressRateLimiter } from "nexus-limiter/middleware/express";
// or
import { expressRateLimiter } from "nexus-limiter";

app.use(expressRateLimiter(limiter));

// Route-specific
app.post("/api/login", expressRateLimiter(loginLimiter), handler);
```

### Fastify

```typescript
import { fastifyRateLimiter } from "nexus-limiter/middleware/fastify";

// Global
app.addHook("onRequest", fastifyRateLimiter(limiter));

// Route-specific
app.get("/api", {
  onRequest: fastifyRateLimiter(limiter)
}, handler);
```

### NestJS

```typescript
import { RateLimitModule, RateLimitGuard } from "nexus-limiter/middleware/nestjs";
import { MemoryStore } from "nexus-limiter";

// app.module.ts
@Module({
  imports: [
    RateLimitModule.forRoot({
      store:    new MemoryStore(),
      limit:    100,
      windowMs: 60_000,
    })
  ]
})
export class AppModule {}

// Apply to controller
@UseGuards(RateLimitGuard)
@Controller("api")
export class ApiController {}

// Apply to specific route
@UseGuards(RateLimitGuard)
@Get("heavy")
heavyEndpoint() {}

// Apply globally
app.useGlobalGuards(app.get(RateLimitGuard));
```

### Hono

```typescript
import { honoRateLimiter } from "nexus-limiter/middleware/hono";

app.use("*", honoRateLimiter(limiter));

// Route-specific
app.use("/api/*", honoRateLimiter(apiLimiter));
```

---

## Configuration

Full configuration reference:

```typescript
const limiter = new RateLimiter({
  // Required
  store:     new MemoryStore(),  // storage backend
  limit:     100,                // max requests per window
  windowMs:  60_000,             // window duration in milliseconds

  // Algorithm
  algorithm: Algorithm.TOKEN,    // default: TOKEN

  // Request cost
  weight:    1,                  // cost per request — default 1

  // Key generation
  keyGenerator: (req) => req.headers["x-api-key"] ?? req.ip,

  // Skip rate limiting for specific requests
  skip: (req) => req.ip === "127.0.0.1",

  // Headers
  headers: true,                 // send X-RateLimit-* headers — default true

  // Fail behaviour when store is unavailable
  failOpen: true,                // allow requests on store failure — default true

  // Callbacks
  onLimitReached: (req, res, result) => {
    console.log(`Rate limit exceeded for ${result.key}`);
  },

  onError: (error, req, res) => {
    console.error("Rate limiter error:", error);
  },

  // Plugins
  plugins: [LoggerPlugin, MetricsPlugin],
});
```

---

## Response headers

When `headers: true` (default), these headers are set on every response:

| Header | Description |
|---|---|
| `X-RateLimit-Limit` | Maximum requests allowed |
| `X-RateLimit-Remaining` | Requests remaining in current window |
| `X-RateLimit-Reset` | Unix timestamp when window resets (seconds) |
| `Retry-After` | Seconds until next request allowed (429 only) |

---

## Weight — variable request cost

Charge different costs per endpoint:

```typescript
const limiter = new RateLimiter({
  store:    new MemoryStore(),
  limit:    100,
  windowMs: 60_000,
  weight:   1,  // default cost
});

// Heavy endpoint costs 10 tokens
app.post("/api/export", expressRateLimiter(
  new RateLimiter({ ...config, weight: 10 })
), handler);
```

---

## Plugins

Plugins receive lifecycle hooks for every request:

```typescript
import type { RateLimitPlugin } from "nexus-limiter";

const LoggerPlugin: RateLimitPlugin = {
  name: "logger",

  onRequestStart: (ctx) => {
    console.log(`[${ctx.method}] ${ctx.path} — key: ${ctx.key}`);
  },

  onRequestEnd: (ctx, result) => {
    console.log(`allowed: ${result.allowed}, remaining: ${result.remaining}`);
  },

  onError: (error, ctx) => {
    console.error(`Rate limiter error on ${ctx.path}:`, error);
  },
};

const limiter = new RateLimiter({
  store:   new MemoryStore(),
  limit:   100,
  windowMs: 60_000,
  plugins: [LoggerPlugin],
});
```

---

## Multiple limiters

Apply different limits to different routes:

```typescript
const globalLimiter = new RateLimiter({
  store:    new MemoryStore(),
  limit:    1000,
  windowMs: 60_000,
});

const authLimiter = new RateLimiter({
  store:     new RedisStore({ url: REDIS_URL }),
  limit:     5,
  windowMs:  60_000,
  algorithm: Algorithm.SLIDING_LOG,
});

const apiLimiter = new RateLimiter({
  store:     new RedisStore({ url: REDIS_URL }),
  limit:     100,
  windowMs:  60_000,
  algorithm: Algorithm.TOKEN,
  weight:    1,
});

app.use(expressRateLimiter(globalLimiter));
app.post("/auth/login",  expressRateLimiter(authLimiter), loginHandler);
app.use("/api",          expressRateLimiter(apiLimiter));
```

---

## Key generation

By default, requests are identified by IP address. Customise with `keyGenerator`:

```typescript
// By API key
const limiter = new RateLimiter({
  store:    new MemoryStore(),
  limit:    1000,
  windowMs: 60_000,
  keyGenerator: (req) => {
    return req.headers["x-api-key"] as string ?? req.ip;
  },
});

// By user ID (after auth middleware)
const limiter = new RateLimiter({
  store:    new MemoryStore(),
  limit:    100,
  windowMs: 60_000,
  keyGenerator: (req) => req.user?.id ?? req.ip,
});

// By route + IP
const limiter = new RateLimiter({
  store:    new MemoryStore(),
  limit:    50,
  windowMs: 60_000,
  keyGenerator: (req) => `${req.path}:${req.ip}`,
});
```

> **Security note:** If using `x-forwarded-for` for IP detection behind a proxy, configure your proxy settings correctly. In Express: `app.set("trust proxy", 1)`. Only trust headers from known proxies.

---

## TypeScript

nexus-limiter is written in TypeScript and ships with full type definitions. No `@types` package needed.

```typescript
import type {
  RateLimiterConfig,
  RateLimitResult,
  RateLimitPlugin,
  RateLimitStore,
  AlgorithmConfig,
} from "nexus-limiter";
```

---

## Error handling

nexus-limiter uses typed errors:

```typescript
import { RateLimitError } from "nexus-limiter";

const limiter = new RateLimiter({
  store:    new MemoryStore(),
  limit:    100,
  windowMs: 60_000,
  onError:  (error, req, res) => {
    if (error instanceof RateLimitError) {
      console.error(`[${error.code}] ${error.message}`, error.meta);
    }
  }
});
```

Error codes:

| Code | Description |
|---|---|
| `STORE_ERROR` | Storage backend failed |
| `INVALID_CONFIG` | Invalid configuration |
| `INVALID_STORE` | Store doesn't implement required interface |
| `ALGORITHM_ERROR` | Unknown algorithm |
| `KEY_GENERATION_ERROR` | Key generator threw |
| `INTERNAL_ERROR` | Unexpected internal error |

---

## Docker — Redis setup

```yaml
# docker-compose.yml
services:
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    command: >
      redis-server
      --requirepass ${REDIS_PASSWORD}
      --maxmemory 256mb
      --maxmemory-policy allkeys-lru
```

```bash
docker-compose up -d
```

---

## Algorithm comparison

| | Token Bucket | Fixed Window | Sliding Log | Sliding Counter |
|---|---|---|---|---|
| Accuracy | High | Medium | Perfect | ~99% |
| Memory | O(1) | O(1) | O(limit) | O(1) |
| Boundary burst | No | Yes | No | No |
| Best for | General use | Simple limits | Strict APIs | Scale |
| Redis atomic | ✅ | ✅ | ✅ | ✅ |

---

## Contributing

Pull requests are welcome. For major changes, open an issue first.

```bash
git clone https://github.com/Zayn41/rate-limiter.git
cd rate-limiter
npm install
npm test
```

---

## License

MIT © [Zayn Khan](https://github.com/Zayn41)