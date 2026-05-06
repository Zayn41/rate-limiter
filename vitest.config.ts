import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, process.cwd(), "");
    
    return {
        test: {
            // Now TypeScript recognizes 'test'!
            env: {
                REDIS_URL: env.REDIS_URL,
                REDIS_PASSWORD: env.REDIS_PASSWORD
            }
        }
    };
});