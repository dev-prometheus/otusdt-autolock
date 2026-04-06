import { NETWORK, NET, CATCHUP_OVERLAP } from "./config.js";
import { logger } from "./src/logger.js";
import { loadOwnerWallet, loadProviderUrls } from "./src/secrets.js";
import { loadState, advanceBlock } from "./src/state.js";
import { ProviderManager } from "./src/providers.js";
import { GasOracle } from "./src/gasOracle.js";
import { buildIgnoreSet, shouldConsider } from "./src/eventFilter.js";
import { Locker } from "./src/locker.js";

const log = logger.child({ module: "index" });

async function main() {
  log.info(
    {
      network: NETWORK,
      chainId: NET.chainId,
      otusdt: NET.contracts.otusdt,
      gateway: NET.contracts.gateway,
    },
    "otusdt-autolock-bot starting"
  );

  // ─────────────────────────────────────────────
  //  1. Load secrets
  // ─────────────────────────────────────────────
  const ownerWallet = await loadOwnerWallet();
  const { alchemyWssUrl, infuraWssUrl } = await loadProviderUrls();

  // Verify that the decrypted wallet actually matches the token
  // contract owner. If not, lockWallet calls will revert with
  // NotOwner. Fail loud at boot rather than on every lock attempt.
  //
  // This check is done after providers start so we have a read
  // provider available.

  // ─────────────────────────────────────────────
  //  2. Load persistent state
  // ─────────────────────────────────────────────
  const state = await loadState();

  // ─────────────────────────────────────────────
  //  3. Build ignore set from system wallets config
  // ─────────────────────────────────────────────
  const ignoreSet = buildIgnoreSet();

  // ─────────────────────────────────────────────
  //  4. Declare the event handler up front so the
  //     ProviderManager can reference it at construction
  // ─────────────────────────────────────────────
  let locker = null; // assigned after providers are ready

  const onCandidate = async (evt) => {
    const { from, to, txHash, blockNumber } = evt;

    // Advance persistent block marker (fire and forget)
    advanceBlock(blockNumber).catch((err) => {
      log.warn({ err: err.message, blockNumber }, "advanceBlock failed");
    });

    // Filter against the ignore list
    const decision = shouldConsider(from, to, ignoreSet);
    if (!decision.candidate) {
      log.debug(
        { from, to, txHash, reason: decision.reason },
        "transfer skipped by filter"
      );
      return;
    }

    // Hand off to the locker
    if (!locker) {
      log.warn({ to, txHash }, "locker not ready yet, dropping candidate");
      return;
    }

    try {
      await locker.handleCandidate(to, txHash);
    } catch (err) {
      log.error(
        { err: err.message, wallet: to, sourceTxHash: txHash },
        "handleCandidate threw"
      );
    }
  };

  // ─────────────────────────────────────────────
  //  5. Start provider manager
  // ─────────────────────────────────────────────
  const providerManager = new ProviderManager({
    alchemyUrl: alchemyWssUrl,
    infuraUrl: infuraWssUrl,
    onCandidate,
  });
  await providerManager.start();

  // ─────────────────────────────────────────────
  //  6. Start gas oracle (Chainlink price + gas math)
  // ─────────────────────────────────────────────
  const readProvider = providerManager.getReadProvider();
  if (!readProvider) throw new Error("no read provider after manager start");

  const gasOracle = new GasOracle(readProvider);
  await gasOracle.start();

  // ─────────────────────────────────────────────
  //  7. Verify wallet matches token owner
  // ─────────────────────────────────────────────
  const readContract = providerManager.getReadContract();
  const onChainOwner = await readContract.owner();
  if (onChainOwner.toLowerCase() !== ownerWallet.address.toLowerCase()) {
    throw new Error(
      `owner mismatch: keystore wallet is ${ownerWallet.address} but OTUSDT owner is ${onChainOwner}. Cannot submit lockWallet transactions.`
    );
  }
  log.info({ owner: onChainOwner }, "wallet verified as token owner");

  // ─────────────────────────────────────────────
  //  8. Start locker
  // ─────────────────────────────────────────────
  locker = new Locker({ ownerWallet, providerManager, gasOracle });
  locker.start();

  // ─────────────────────────────────────────────
  //  9. Catch up on missed blocks since last run
  // ─────────────────────────────────────────────
  try {
    const currentBlock = await readProvider.getBlockNumber();
    const fromBlock =
      state.lastProcessedBlock > 0
        ? Math.max(0, state.lastProcessedBlock - CATCHUP_OVERLAP)
        : currentBlock; // fresh install, start from current

    if (fromBlock < currentBlock) {
      log.info(
        { fromBlock, toBlock: currentBlock, span: currentBlock - fromBlock },
        "catching up on missed Transfer events"
      );
      const historical = await providerManager.queryHistoricalTransfers(
        fromBlock,
        currentBlock
      );
      log.info({ count: historical.length }, "catch-up fetched");

      for (const evt of historical) {
        // Run each through the same pipeline as live events.
        // Dedup will handle any overlap with live subscriptions that
        // started in parallel.
        const key = `${evt.txHash}:${evt.logIndex}`;
        if (providerManager.hasSeen(key)) continue;
        providerManager.markSeen(key);

        await onCandidate(evt);
      }
      log.info("catch-up complete");
    } else {
      log.info("no catch-up needed");
    }
  } catch (err) {
    log.error({ err: err.message }, "catch-up failed, continuing with live stream");
  }

  log.info("bot running, monitoring Transfer events");

  // ─────────────────────────────────────────────
  //  10. Signal handlers for clean shutdown
  // ─────────────────────────────────────────────
  const shutdown = async (signal) => {
    log.info({ signal }, "shutdown initiated");
    try {
      locker?.stop();
      gasOracle?.stop();
      await providerManager?.stop();
    } catch (err) {
      log.error({ err: err.message }, "error during shutdown");
    }
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  process.on("unhandledRejection", (reason) => {
    log.error({ reason: reason?.message || reason }, "unhandled rejection");
  });
  process.on("uncaughtException", (err) => {
    log.error({ err: err.message, stack: err.stack }, "uncaught exception");
  });
}

main().catch((err) => {
  log.error({ err: err.message, stack: err.stack }, "fatal boot error");
  process.exit(1);
});
