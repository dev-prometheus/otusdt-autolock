import pino from "pino";
import { LOG_LEVEL } from "../config.js";

/**
 * Pino logger configured for structured JSONL output to stdout.
 * One line per log entry, each entry a valid JSON object.
 *
 * Format includes: timestamp, level, message, and any extra fields
 * passed as the first argument. Pipe to jq, grep, or any log
 * aggregator.
 *
 * Examples:
 *   logger.info({ txHash: "0x..." }, "lock submitted")
 *   logger.warn({ err: e.message }, "provider reconnect")
 *   logger.error({ block: 12345 }, "catchup failed")
 */
export const logger = pino({
  level: LOG_LEVEL,
  base: { service: "otusdt-autolock-bot" },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
});

/**
 * Creates a child logger with a persistent context tag.
 * Useful for per-module prefixes so you can grep for "module":"providers"
 * in the log stream.
 *
 * @param {string} module Name of the module creating the child logger
 * @returns {pino.Logger}
 */
export function childLogger(module) {
  return logger.child({ module });
}
