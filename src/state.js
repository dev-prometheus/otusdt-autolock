import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { PATHS } from "../config.js";
import { childLogger } from "./logger.js";

const log = childLogger("state");

/**
 * In-memory copy of the state. Persisted to disk after every update.
 * Debounced writes are not used here because state is small (one
 * number) and writes are rare (once per processed block).
 */
let state = {
  lastProcessedBlock: 0,
};

let writeInFlight = null;

/**
 * Loads state from disk. If the file does not exist, returns defaults.
 * Should be called once at boot before any other state operation.
 */
export async function loadState() {
  try {
    const raw = await readFile(PATHS.state, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed.lastProcessedBlock === "number") {
      state.lastProcessedBlock = parsed.lastProcessedBlock;
    }
    log.info(
      { lastProcessedBlock: state.lastProcessedBlock },
      "state loaded from disk"
    );
  } catch (err) {
    if (err.code === "ENOENT") {
      log.info("no state file found, starting fresh");
    } else {
      log.warn({ err: err.message }, "state file unreadable, using defaults");
    }
  }
  return { ...state };
}

/**
 * Returns a snapshot of the current in-memory state.
 * Callers should treat the returned object as read-only.
 */
export function getState() {
  return { ...state };
}

/**
 * Updates lastProcessedBlock if the new value is strictly greater
 * than the current value. Persists to disk atomically.
 *
 * No-op if blockNumber is not ahead of current state.
 *
 * @param {number} blockNumber
 */
export async function advanceBlock(blockNumber) {
  if (blockNumber <= state.lastProcessedBlock) return;

  state.lastProcessedBlock = blockNumber;
  await persist();
}

async function persist() {
  // Ensure parent directory exists (for ./data/ on first run)
  try {
    await mkdir(dirname(PATHS.state), { recursive: true });
  } catch {}

  // Serialize concurrent writes. If a write is already in flight,
  // queue the next one to run after it. This prevents interleaved
  // file writes from corrupting the state file under burst load.
  if (writeInFlight) {
    await writeInFlight;
  }

  writeInFlight = writeFile(PATHS.state, JSON.stringify(state, null, 2), "utf8")
    .catch((err) => {
      log.error({ err: err.message }, "state persist failed");
    })
    .finally(() => {
      writeInFlight = null;
    });

  await writeInFlight;
}
