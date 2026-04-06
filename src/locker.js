import { Contract, formatEther } from "ethers";
import { NET, DRAIN_INTERVAL_MS, LOCK_GAS_UNITS } from "../config.js";
import { OTUSDT_ABI } from "./abis.js";
import { childLogger } from "./logger.js";
import { isAlreadyLocked } from "./eventFilter.js";

const log = childLogger("locker");

/**
 * Locker owns the lifecycle of lockWallet transactions:
 *   - Submits immediately when gas is under the USD ceiling
 *   - Queues when gas is over the ceiling
 *   - Drains the queue periodically when gas drops
 *   - Serializes nonce management (one tx at a time per wallet)
 */
export class Locker {
  /**
   * @param {object} opts
   * @param {import("ethers").Wallet} opts.ownerWallet Unlocked wallet signer
   * @param {import("./providers.js").ProviderManager} opts.providerManager
   * @param {import("./gasOracle.js").GasOracle} opts.gasOracle
   */
  constructor({ ownerWallet, providerManager, gasOracle }) {
    this.ownerWallet = ownerWallet;
    this.providerManager = providerManager;
    this.gasOracle = gasOracle;

    /**
     * Pending queue: wallets awaiting a gas window.
     * Stored as a Map keyed by lowercased address so duplicates
     * get coalesced automatically.
     * @type {Map<string, { address: string, queuedAt: number, sourceTxHash: string }>}
     */
    this.pending = new Map();

    /**
     * Serializes submissions so two Transfer events do not race
     * to grab the same nonce. Chain of promises.
     */
    this.submitChain = Promise.resolve();

    this.drainTimer = null;
    this.stopped = false;
  }

  start() {
    this.drainTimer = setInterval(() => {
      if (this.stopped) return;
      this.drainQueue().catch((err) => {
        log.error({ err: err.message }, "drain loop error");
      });
    }, DRAIN_INTERVAL_MS);
    if (this.drainTimer.unref) this.drainTimer.unref();
    log.info({ drainIntervalMs: DRAIN_INTERVAL_MS }, "locker started");
  }

  stop() {
    this.stopped = true;
    if (this.drainTimer) clearInterval(this.drainTimer);
  }

  /**
   * Main entry point called by the event pipeline for every
   * lock-candidate wallet.
   */
  async handleCandidate(walletAddress, sourceTxHash) {
    const lower = walletAddress.toLowerCase();

    // Fast path: already pending, no-op
    if (this.pending.has(lower)) {
      log.debug({ wallet: lower }, "candidate already queued, skipping");
      return;
    }

    // Check on-chain lock state before doing anything else
    const readContract = this.providerManager.getReadContract();
    if (!readContract) {
      log.error("no read contract for isLocked check, queueing defensively");
      this.pending.set(lower, {
        address: walletAddress,
        queuedAt: Date.now(),
        sourceTxHash,
      });
      return;
    }

    const alreadyLocked = await isAlreadyLocked(readContract, walletAddress);
    if (alreadyLocked) {
      log.info({ wallet: walletAddress, sourceTxHash }, "wallet already locked, skipping");
      return;
    }

    // Check gas ceiling
    const gasStatus = await this.gasOracle.check();

    if (!gasStatus.ok) {
      this.pending.set(lower, {
        address: walletAddress,
        queuedAt: Date.now(),
        sourceTxHash,
      });
      log.info(
        {
          wallet: walletAddress,
          currentGwei: gasStatus.currentGwei,
          maxGwei: gasStatus.maxGwei,
          ethPriceUsd: gasStatus.ethPriceUsd,
          queueSize: this.pending.size,
        },
        "gas above ceiling, queued for later"
      );
      return;
    }

    // Gas is fine, submit immediately
    await this.submitLock(walletAddress, sourceTxHash, gasStatus);
  }

  /**
   * Serializes all submissions through a promise chain to avoid
   * nonce collisions between concurrent lock attempts.
   */
  submitLock(walletAddress, sourceTxHash, gasStatus) {
    const task = async () => {
      try {
        await this.doSubmit(walletAddress, sourceTxHash, gasStatus);
      } catch (err) {
        log.error(
          { wallet: walletAddress, sourceTxHash, err: err.message },
          "lock submission failed, re-queueing"
        );
        // Put back in the queue for the drain loop to retry
        this.pending.set(walletAddress.toLowerCase(), {
          address: walletAddress,
          queuedAt: Date.now(),
          sourceTxHash,
        });
      }
    };

    // Chain it so only one tx signs/sends at a time
    this.submitChain = this.submitChain.then(task, task);
    return this.submitChain;
  }

  /**
   * Actually signs and sends the lockWallet transaction.
   */
  async doSubmit(walletAddress, sourceTxHash, gasStatus) {
    // Double-check lock state right before sending, in case a racing
    // event already locked it during the queue wait
    const readContract = this.providerManager.getReadContract();
    if (readContract) {
      const alreadyLocked = await isAlreadyLocked(readContract, walletAddress);
      if (alreadyLocked) {
        log.info(
          { wallet: walletAddress },
          "wallet became locked during queue wait, skipping"
        );
        this.pending.delete(walletAddress.toLowerCase());
        return;
      }
    }

    // Bind the OTUSDT contract to our wallet signer.
    // The signer is tied to the provider it was constructed with.
    const provider = this.providerManager.getReadProvider();
    if (!provider) {
      throw new Error("no provider available to send lockWallet tx");
    }
    const connectedWallet = this.ownerWallet.connect(provider);
    const otusdt = new Contract(NET.contracts.otusdt, OTUSDT_ABI, connectedWallet);

    log.info(
      {
        wallet: walletAddress,
        sourceTxHash,
        currentGwei: gasStatus.currentGwei,
        maxGwei: gasStatus.maxGwei,
      },
      "submitting lockWallet transaction"
    );

    const tx = await otusdt.lockWallet(walletAddress, {
      maxFeePerGas: gasStatus.maxFeePerGas,
      maxPriorityFeePerGas: gasStatus.maxPriorityFeePerGas,
      gasLimit: LOCK_GAS_UNITS,
    });

    log.info(
      {
        wallet: walletAddress,
        sourceTxHash,
        txHash: tx.hash,
        nonce: tx.nonce,
      },
      "lockWallet tx submitted, waiting for receipt"
    );

    const receipt = await tx.wait();

    const gasUsedWei = receipt.gasUsed * (receipt.gasPrice ?? gasStatus.maxFeePerGas);
    const gasUsedEth = Number(formatEther(gasUsedWei));
    const gasUsedUsd = gasUsedEth * gasStatus.ethPriceUsd;

    log.info(
      {
        wallet: walletAddress,
        sourceTxHash,
        txHash: receipt.hash,
        block: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString(),
        gasCostEth: gasUsedEth,
        gasCostUsd: gasUsedUsd.toFixed(4),
        explorerUrl: `${NET.explorer}/tx/${receipt.hash}`,
      },
      "lockWallet confirmed"
    );

    // Remove from pending if it was there
    this.pending.delete(walletAddress.toLowerCase());
  }

  /**
   * Drain loop: runs every DRAIN_INTERVAL_MS. If gas has dropped
   * below the ceiling, pushes each queued wallet through submitLock.
   */
  async drainQueue() {
    if (this.pending.size === 0) return;

    const gasStatus = await this.gasOracle.check();
    if (!gasStatus.ok) {
      log.debug(
        {
          queueSize: this.pending.size,
          currentGwei: gasStatus.currentGwei,
          maxGwei: gasStatus.maxGwei,
        },
        "drain check: gas still above ceiling"
      );
      return;
    }

    log.info(
      {
        queueSize: this.pending.size,
        currentGwei: gasStatus.currentGwei,
        maxGwei: gasStatus.maxGwei,
      },
      "gas window open, draining queue"
    );

    // Snapshot the queue so we can iterate without mutation races
    const snapshot = Array.from(this.pending.values());

    for (const item of snapshot) {
      if (this.stopped) break;

      // Refresh gas status every few submissions in case the window closes
      const fresh = await this.gasOracle.check();
      if (!fresh.ok) {
        log.info(
          { remaining: this.pending.size, currentGwei: fresh.currentGwei, maxGwei: fresh.maxGwei },
          "gas window closed mid-drain, pausing"
        );
        break;
      }

      // Pull out of the map first so submitLock's failure-requeue
      // handler does not race with our loop iteration
      this.pending.delete(item.address.toLowerCase());

      await this.submitLock(item.address, item.sourceTxHash, fresh);
    }
  }
}
