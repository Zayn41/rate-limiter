import type { RateLimitConfig } from "../types/config";
import { Algorithm } from "../types/config";
import { RateLimitError } from "../types/error";

/**
 * Validates rate limiter configuration.
 * 
 * Ensures all required fields are present and valid,
 * preventing invalid configurations from causing issues at runtime.
 * 
 * Validation checks:
 * - store: Required, implements RateLimitStore interface
 * - limit: Positive number
 * - windowMs: Positive number
 * - weight: Positive number, doesn't exceed limit
 * - algorithm: Valid algorithm if provided
 * - keyGenerator: Function if provided
 * - skip: Function if provided
 * - plugins: Valid names and hooks
 * 
 * @param config - Configuration to validate
 * @throws {RateLimitError} If any validation fails
 * 
 * @example
 * ```ts
 * try {
 *   validateConfig(config);
 * } catch (err) {
 *   if (err instanceof RateLimitError) {
 *     console.error(`Config error: ${err.message}`);
 *   }
 * }
 * ```
 */
export function validateConfig<TReq>(config: RateLimitConfig<TReq>):void { 
    validateStore(config);
    validateLimits(config);
    validateAlgorithm(config);
    validateCallbacks(config);
    validatePlugins(config);
}

function validateStore<TReq>(config: RateLimitConfig<TReq>): void {
    if(!config.store) {
        throw new RateLimitError("INVALID_CONFIG", "store is required");
    }

    if (typeof config.store.name !== "string" || !config.store.name.trim()) {
        throw new RateLimitError("INVALID_STORE", "store must have a valid name property");
    }

    if (
        typeof config.store.get !== "function" ||
        typeof config.store.set !== "function" ||
        typeof config.store.delete !== "function"
    ) {
        throw new RateLimitError("INVALID_STORE", "store must implement get, set, and delete methods");
    }
}

function validateLimits<TReq>(config: RateLimitConfig<TReq>): void {
    if(!Number.isFinite(config.limit) || !Number.isInteger(config.limit) || config.limit <= 0) {
        throw new RateLimitError(
            "INVALID_CONFIG",
            `limit must be a positive finite integer, got ${config.limit}`,
            { field: "limit", value: config.limit }
        );
    }

    if(!Number.isFinite(config.windowMs) || config.windowMs < 100) {
        throw new RateLimitError(
            "INVALID_CONFIG",
            `windowMs must be a finite number >= 100ms, got ${config.windowMs}`,
            { field: "windowMs", value: config.windowMs }
        );
    }

    if(config.weight !== undefined) {
        if(!Number.isFinite(config.weight) || config.weight <= 0) {
            throw new RateLimitError(
                "INVALID_CONFIG",
                `weight must be a positive finite number, got ${config.weight}`,
                { field: "weight", value: config.weight }
            );
        }

        if(config.weight > config.limit) {
            throw new RateLimitError(
                "INVALID_CONFIG",
                `weight (${config.weight}) cannot exceed limit (${config.limit})`,
                { weight: config.weight, limit: config.limit }
            );
        }
    }

    if(config.failOpen !== undefined && typeof config.failOpen !== "boolean") {
        throw new RateLimitError("INVALID_CONFIG", "failOpen must be a boolean",
            { field: "failOpen", value: typeof config.failOpen }
        );
    }

    if(config.headers !== undefined && typeof config.headers !== "boolean") {
        throw new RateLimitError("INVALID_CONFIG", "headers must be a boolean", {
            field: "headers", value: typeof config.headers
        });
    }
}

function validateAlgorithm<TReq>(config: RateLimitConfig<TReq>): void {
    if(config.algorithm && !Object.values(Algorithm).includes(config.algorithm)) {
        throw new RateLimitError(
            "ALGORITHM_ERROR",
            `invalid algorithm: ${config.algorithm}`,
            { field: "algorithm", value: config.algorithm, validOptions: Object.values(Algorithm) }
        );
    }
}

function validateCallbacks<TReq>(config: RateLimitConfig<TReq>): void {
    const fns = ["keyGenerator", "skip", "onError", "onLimitReached"] as const;
    for(const key of fns) {
        if(config[key] !== undefined && typeof config[key] !== "function") {
            throw new RateLimitError(
                "INVALID_CONFIG",
                `${key} must be a function`,
                { field: key, value: typeof config[key] }
            );
        }
    }
}

function validatePlugins<TReq>(config: RateLimitConfig<TReq>): void {
    if(!config.plugins?.length) {
        return;
    }

    const names: string[] = [];

    config.plugins?.forEach((plugin, index) => {
        if(!plugin) {
            throw new RateLimitError("INVALID_CONFIG", `plugin at index ${index} is null or undefined`);
        }

        if(typeof plugin.name !== "string" || !plugin.name.trim()) {
            throw new RateLimitError("INVALID_CONFIG", `plugin at index ${index} missing valid name`, { index });
        }

        names.push(plugin.name);

        const hasHooks = plugin.onRequestStart || plugin.onRequestEnd || plugin.onError;
        if(!hasHooks) {
            throw new RateLimitError(
                "INVALID_CONFIG",
                `plugin "${plugin.name}" must implement at least one hook`,
                { index, pluginName: plugin.name }
            );
        }

        const hooks = ["onRequestStart", "onRequestEnd", "onError"] as const;
        for(const hook of hooks) {
            if(plugin[hook] !== undefined && typeof plugin[hook] !== "function") {
                throw new RateLimitError(
                    "INVALID_CONFIG",
                    `plugin "${plugin.name}" ${hook} must be a function`,
                    { index, pluginName: plugin.name, hook }
                );
            }
        }
    });

    // Check duplicates names 
    const duplicates = names.filter((name, i) => names.indexOf(name) !== i);
    if(duplicates.length > 0) {
        throw new RateLimitError(
            "INVALID_CONFIG",
            `duplicate plugin names: ${[...new Set(duplicates)].join(", ")}`,
            { duplicates }
        );
    }
}