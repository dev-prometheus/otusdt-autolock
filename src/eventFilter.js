import { ZeroAddress } from "ethers";
import { NET, SYSTEM_WALLETS } from "../config.js";
import { childLogger } from "./logger.js";

const log = childLogger("eventFilter");

/**
 * Build the canonical ignore set at boot time. All addresses are
 * lowercased for case-insensitive comparison.
 *
 * Includes:
 *   - Zero address (minting events, defensive)
 *   - OTUSDT contract itself (protocolDistribute outflows,
 *     recovered token returns)
 *   - OTGateway contract (withdraw two-step flow, recovery)
 *   - Owner wallet (admin operations)
 *   - Smart contract wallet (fee recipient)
 *   - Platform wallet (fee recipient)
 *   - Treasury wallet (when redemption ships, null for now)
 */
export function buildIgnoreSet() {
  const ignore = new Set();

  const addIfValid = (label, addr) => {
    if (!addr) return;
    if (typeof addr !== "string") return;
    if (addr.startsWith("PASTE_")) {
      log.warn({ label, addr }, "placeholder address in config, ignoring");
      return;
    }
    const lower = addr.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(lower)) {
      log.warn({ label, addr }, "malformed address in config, ignoring");
      return;
    }
    ignore.add(lower);
  };

  addIfValid("zero", ZeroAddress);
  addIfValid("otusdt", NET.contracts.otusdt);
  addIfValid("gateway", NET.contracts.gateway);
  addIfValid("owner", SYSTEM_WALLETS.owner);
  addIfValid("smartContract", SYSTEM_WALLETS.smartContract);
  addIfValid("platform", SYSTEM_WALLETS.platform);
  addIfValid("treasury", SYSTEM_WALLETS.treasury);

  log.info({ count: ignore.size, addresses: Array.from(ignore) }, "ignore set built");
  return ignore;
}

/**
 * Decides whether a Transfer event is a lock candidate.
 *
 * A candidate must:
 *   - Have a non-zero `to` address
 *   - Have `to` NOT in the ignore set
 *   - Have `from` NOT in the ignore set (if `from` is a system
 *     wallet, the recipient may still be legitimate but we skip
 *     to avoid locking distribution destinations prematurely;
 *     those are locked manually if needed)
 *
 * Returns { candidate: boolean, reason: string }
 *
 * @param {string} from
 * @param {string} to
 * @param {Set<string>} ignoreSet
 */
export function shouldConsider(from, to, ignoreSet) {
  const f = from.toLowerCase();
  const t = to.toLowerCase();

  if (ignoreSet.has(f)) {
    return { candidate: false, reason: `from is system wallet (${f})` };
  }
  if (ignoreSet.has(t)) {
    return { candidate: false, reason: `to is system wallet (${t})` };
  }
  return { candidate: true, reason: "ok" };
}

/**
 * Checks the on-chain lock state of a wallet via the OTUSDT contract.
 * Used as the final gate before submitting a lockWallet transaction,
 * to avoid wasting gas re-locking wallets already locked.
 *
 * @param {import("ethers").Contract} otusdtRead Read-only OTUSDT contract
 * @param {string} wallet
 * @returns {Promise<boolean>}
 */
export async function isAlreadyLocked(otusdtRead, wallet) {
  try {
    return await otusdtRead.isLocked(wallet);
  } catch (err) {
    log.warn(
      { wallet, err: err.message },
      "isLocked check failed, assuming not locked"
    );
    return false;
  }
}
