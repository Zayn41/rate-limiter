import { defineConfig } from "tsup";
import { copyFileSync, mkdirSync, readdirSync, existsSync } from "fs";
import { join } from "path";

export default defineConfig({
    entry: {
        "index": "src/index.ts",
        "store/redis-export": "src/store/redis-export.ts",
        "middleware/express": "src/middlewares/express.ts",
        "middleware/fastify": "src/middlewares/fastify.ts",
        "middleware/hono": "src/middlewares/hono.ts",
        "middleware/nestjs": "src/nest/index.ts"
    },
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
    sourcemap: true,
    shims: true,
    // Don't bundle these — users bring their own
    external: [
        // Frameworks
        "express",
        "fastify",
        "hono",
        "ioredis",

        // NestJS — entire ecosystem marked external
        "@nestjs/common",
        "@nestjs/core",
        "@nestjs/platform-express",
        "reflect-metadata",
        "rxjs",
        "rxjs/operators",

        // NestJS optional deps that cause bundle errors
        "class-transformer",
        "class-validator",
    ],

    onSuccess: async () => {
        // Copy Lua scripts to dist because tsup doesn't bundle non-TS files
        const srcLua  = join("src",  "store", "lua");
        const distLua = join("dist", "store", "lua");

        if(!existsSync(srcLua)) {
            console.warn("No Lua directory found at", srcLua);
            return;
        }

        mkdirSync(distLua, { recursive: true });

        const files = readdirSync(srcLua).filter(f => f.endsWith(".lua"));
        files.forEach(f => copyFileSync(join(srcLua, f), join(distLua, f)));

        console.log(`✓ Copied ${files.length} Lua files → dist/store/lua/`);
    }
});