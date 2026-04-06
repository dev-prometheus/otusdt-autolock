import { WebSocketProvider, Contract } from "ethers";
import { NET, DEDUP_CACHE_SIZE, WATCHDOG_SILENCE_MS } from "../config.js";
import { OTUSDT_ABI } from "./abis.js";
import { childLogger } from "./logger.js";

const log = childLogger("providers");

const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Manages two parallel WebSocket providers (Alchemy + Infura) with:
 *   - Deduplicated Transfer event delivery
 *   - Independent reconnection per provider
 *   - Heartbeat health checks via getBlockNumber
 *   - A shared read provider for on-demand calls (isLocked, gas, price)
 *   - Historical event query for catch-up on boot
 *
 * Events from either provider are forwarded to the onCandidate
 * callback exactly once, keyed by txHash:logIndex.
 */
export class ProviderManager {
  /**
   * @param {object} opts
   * @param {string} opts.alchemyUrl
   * @param {string} opts.infuraUrl
   * @param {(evt: object) => void} opts.onCandidate
   */
  constructor({ alchemyUrl, infuraUrl, onCandidate }) {
    this.onCandidate = onCandidate;
    this.sessions = [
      { name: "alchemy", url: alchemyUrl, provider: null, contract: null, handler: null, healthy: false },
      { name: "infura", url: infuraUrl, provider: null, contract: null, handler: null, healthy: false },
    ];

    /** @type {Set<string>} */
    this.dedup = new Set();
    /** @type {string[]} FIFO order for LRU eviction */
    this.dedupOrder = [];

    this.lastEventAt = Date.now();
    this.heartbeatTimer = null;
    this.stopped = false;
  }

  async start() {
    for (const session of this.sessions) {
      await this.connectSession(session);
    }
    this.startHeartbeat();

    const healthy = this.sessions.filter((s) => s.healthy).length;
    if (healthy === 0) {
      throw new Error("no providers connected successfully at boot");
    }
    log.info({ healthy, total: this.sessions.length }, "provider manager started");
  }

  /**
   * Opens a fresh WebSocket provider and subscribes to the Transfer
   * event. Marks the session healthy on success.
   */
  async connectSession(session) {
    try {
      const provider = new WebSocketProvider(session.url, {
        chainId: NET.chainId,
        name: NET.name,
      });

      // Smoke test: fetch block number. If this fails, the socket
      // is not usable and we bail early.
      await provider.getBlockNumber();

      const contract = new Contract(NET.contracts.otusdt, OTUSDT_ABI, provider);

      const handler = (from, to, value, event) => {
        this.handleTransferEvent(session.name, from, to, value, event);
      };

      await contract.on("Transfer", handler);

      // Hook underlying websocket close/error events if accessible.
      // These trigger faster reconnection than waiting for heartbeat.
      try {
        const ws = provider.websocket;
        if (ws && typeof ws.on === "function") {
          ws.on("close", () => {
            if (session.healthy) {
              log.warn({ name: session.name }, "websocket closed");
              session.healthy = false;
            }
          });
          ws.on("error", (err) => {
            if (session.healthy) {
              log.warn({ name: session.name, err: err?.message }, "websocket error");
              session.healthy = false;
            }
          });
        }
      } catch {
        // Socket event hooking is best-effort; heartbeat loop covers us
      }

      session.provider = provider;
      session.contract = contract;
      session.handler = handler;
      session.healthy = true;
      log.info({ name: session.name }, "provider session connected");
    } catch (err) {
      session.provider = null;
      session.contract = null;
      session.handler = null;
      session.healthy = false;
      log.error(
        { name: session.name, err: err.message },
        "provider session connect failed"
      );
    }
  }

  /**
   * Tears down a session (removes listener, destroys provider) so
   * it can be cleanly reconnected.
   */
  async teardownSession(session) {
    try {
      if (session.contract && session.handler) {
        await session.contract.off("Transfer", session.handler);
      }
    } catch {}
    try {
      if (session.provider) {
        await session.provider.destroy();
      }
    } catch {}
    session.provider = null;
    session.contract = null;
    session.handler = null;
    session.healthy = false;
  }

  /**
   * Dedup + dispatch for incoming Transfer events.
   */
  handleTransferEvent(providerName, from, to, value, event) {
    const txHash = event?.log?.transactionHash;
    const logIndex = event?.log?.index;

    if (!txHash || logIndex === undefined) {
      log.warn({ providerName }, "transfer event missing txHash or logIndex");
      return;
    }

    const key = `${txHash}:${logIndex}`;

    if (this.hasSeen(key)) {
      // Already processed via the other provider
      return;
    }

    this.markSeen(key);

    this.lastEventAt = Date.now();

    log.info(
      {
        provider: providerName,
        from,
        to,
        value: value.toString(),
        txHash,
        block: event.log.blockNumber,
        logIndex,
      },
      "transfer event received"
    );

    try {
      this.onCandidate({
        from,
        to,
        value,
        txHash,
        blockNumber: event.log.blockNumber,
        logIndex,
      });
    } catch (err) {
      log.error({ err: err.message, txHash }, "onCandidate handler threw");
    }
  }

  /**
   * Periodic health check + reconnection loop.
   */
  startHeartbeat() {
    this.heartbeatTimer = setInterval(async () => {
      if (this.stopped) return;

      // Check each session
      for (const session of this.sessions) {
        if (session.provider) {
          try {
            await session.provider.getBlockNumber();
            if (!session.healthy) {
              log.info({ name: session.name }, "provider recovered on heartbeat");
              session.healthy = true;
            }
          } catch (err) {
            if (session.healthy) {
              log.warn(
                { name: session.name, err: err.message },
                "heartbeat failed, marking unhealthy"
              );
            }
            session.healthy = false;
          }
        }
      }

      // Reconnect any unhealthy sessions
      for (const session of this.sessions) {
        if (!session.healthy) {
          log.info({ name: session.name }, "attempting reconnect");
          await this.teardownSession(session);
          await this.connectSession(session);
        }
      }

      // Log extended silence for observability
      const silence = Date.now() - this.lastEventAt;
      if (silence > WATCHDOG_SILENCE_MS) {
        log.debug({ silenceMs: silence }, "extended silence, sockets healthy");
      }

      // Check if we have at least one healthy provider
      const healthy = this.sessions.filter((s) => s.healthy).length;
      if (healthy === 0) {
        log.error("no healthy providers, bot cannot receive events");
      }
    }, HEARTBEAT_INTERVAL_MS);

    if (this.heartbeatTimer.unref) this.heartbeatTimer.unref();
  }

  /**
   * Returns the first healthy provider for on-demand reads.
   * Falls back to any provider if none are marked healthy.
   */
  getReadProvider() {
    for (const s of this.sessions) {
      if (s.healthy && s.provider) return s.provider;
    }
    for (const s of this.sessions) {
      if (s.provider) return s.provider;
    }
    return null;
  }

  /**
   * Checks whether an event has already been seen by the dedup cache.
   * @param {string} key txHash:logIndex composite
   */
  hasSeen(key) {
    return this.dedup.has(key);
  }

  /**
   * Marks an event as seen in the dedup cache. Used by the catch-up
   * pipeline in index.js to keep live and historical streams from
   * processing the same log twice.
   * @param {string} key txHash:logIndex composite
   */
  markSeen(key) {
    if (this.dedup.has(key)) return;
    this.dedup.add(key);
    this.dedupOrder.push(key);
    while (this.dedupOrder.length > DEDUP_CACHE_SIZE) {
      const evicted = this.dedupOrder.shift();
      this.dedup.delete(evicted);
    }
  }

  /**
   * Returns a read-only OTUSDT Contract instance bound to the current
   * healthy provider. Rebinds on every call so it always reflects
   * the latest healthy session.
   */
  getReadContract() {
    const p = this.getReadProvider();
    if (!p) return null;
    return new Contract(NET.contracts.otusdt, OTUSDT_ABI, p);
  }

  /**
   * Fetches historical Transfer events between two blocks.
   * Used for catch-up on boot.
   */
  async queryHistoricalTransfers(fromBlock, toBlock) {
    const contract = this.getReadContract();
    if (!contract) throw new Error("no healthy provider for catch-up query");

    const filter = contract.filters.Transfer();
    const events = await contract.queryFilter(filter, fromBlock, toBlock);

    return events.map((e) => ({
      from: e.args.from,
      to: e.args.to,
      value: e.args.value,
      txHash: e.transactionHash,
      blockNumber: e.blockNumber,
      logIndex: e.index,
    }));
  }

  async stop() {
    this.stopped = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const session of this.sessions) {
      await this.teardownSession(session);
    }
    log.info("provider manager stopped");
  }
}
