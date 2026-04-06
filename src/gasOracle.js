import { Contract, parseUnits, formatUnits } from "ethers";
import { NET, MAX_GAS_USD, LOCK_GAS_UNITS, PRIORITY_TIP_GWEI, PRICE_REFRESH_MS } from "../config.js";
import { CHAINLINK_ABI } from "./abis.js";
import { childLogger } from "./logger.js";

const log = childLogger("gasOracle");

/**
 * GasOracle tracks the current ETH/USD price and computes whether
 * the current network gas cost is below the configured USD ceiling
 * for a single lockWallet transaction.
 *
 * It uses the Chainlink on-chain ETH/USD feed as the price source
 * (same pattern as the dApp). Price is cached in memory and refreshed
 * every PRICE_REFRESH_MS.
 */
export class GasOracle {
  /**
   * @param {import("ethers").Provider} readProvider Any working provider
   */
  constructor(readProvider) {
    this.provider = readProvider;
    this.feed = new Contract(NET.contracts.ethUsdFeed, CHAINLINK_ABI, readProvider);
    /** @type {number | null} */
    this.ethPriceUsd = null;
    this.refreshTimer = null;
  }

  /**
   * Reads the Chainlink feed immediately and starts a background
   * refresh timer. Call once at boot.
   */
  async start() {
    await this.refreshPrice();
    this.refreshTimer = setInterval(() => {
      this.refreshPrice().catch((err) => {
        log.warn({ err: err.message }, "price refresh failed, keeping last value");
      });
    }, PRICE_REFRESH_MS);
    // Don't let this timer keep the event loop alive on its own.
    if (this.refreshTimer.unref) this.refreshTimer.unref();
  }

  async refreshPrice() {
    try {
      const [, answer] = await this.feed.latestRoundData();
      // Chainlink ETH/USD on mainnet and Sepolia both use 8 decimals
      const price = Number(answer) / 1e8;
      if (!Number.isFinite(price) || price <= 0) {
        throw new Error(`invalid price from oracle: ${answer}`);
      }
      this.ethPriceUsd = price;
      log.info({ ethPriceUsd: price }, "eth price refreshed");
    } catch (err) {
      if (this.ethPriceUsd === null) {
        // First read failed, fall back to a safe default so the bot
        // can still operate. Real price will update on next refresh.
        this.ethPriceUsd = 2000;
        log.warn(
          { err: err.message, fallback: this.ethPriceUsd },
          "initial price read failed, using fallback"
        );
      } else {
        throw err;
      }
    }
  }

  /**
   * Returns the maximum gwei we are willing to pay per gas unit,
   * derived from MAX_GAS_USD, current ETH price, and LOCK_GAS_UNITS.
   *
   * Example: $2 cap, $2000 ETH, 60000 gas units
   *          = ($2 / $2000) ETH budget = 0.001 ETH
   *          = 0.001 / 60000 ETH per gas
   *          = 16.67 gwei per gas
   *
   * @returns {bigint} Max fee per gas in wei
   */
  getMaxFeePerGasWei() {
    if (this.ethPriceUsd === null) return 0n;

    // ETH budget in ether: MAX_GAS_USD / ethPriceUsd
    // Convert to wei per gas: (budgetEth * 1e18) / gasUnits
    //
    // We do this with BigInt math to avoid floating point loss at
    // the wei scale. Multiply by a large scalar, then divide.
    const SCALE = 1_000_000_000_000n; // 1e12 for precision
    const budgetScaled = BigInt(Math.floor((MAX_GAS_USD / this.ethPriceUsd) * Number(SCALE)));
    const budgetWei = (budgetScaled * 10n ** 18n) / SCALE;
    const maxFeePerGas = budgetWei / LOCK_GAS_UNITS;
    return maxFeePerGas;
  }

  /**
   * Reads the current network fee data and determines if it is
   * within the USD cap.
   *
   * @returns {Promise<{ok: boolean, currentGwei: number, maxGwei: number, maxFeePerGas: bigint, maxPriorityFeePerGas: bigint}>}
   */
  async check() {
    const feeData = await this.provider.getFeeData();
    const baseFee = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
    const priorityTip = parseUnits(PRIORITY_TIP_GWEI.toString(), "gwei");

    // Ensure we always submit with at least priority_tip above base fee
    const effectiveMaxFee = baseFee + priorityTip;

    const ceiling = this.getMaxFeePerGasWei();
    const ok = ceiling > 0n && effectiveMaxFee <= ceiling;

    return {
      ok,
      currentGwei: Number(formatUnits(effectiveMaxFee, "gwei")),
      maxGwei: Number(formatUnits(ceiling, "gwei")),
      maxFeePerGas: effectiveMaxFee,
      maxPriorityFeePerGas: priorityTip,
      ethPriceUsd: this.ethPriceUsd,
    };
  }

  stop() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }
}
