// ╔══════════════════════════════════════════════════════════════╗
// ║  OTUSDT Auto-Lock Bot Configuration                         ║
// ║  Change NETWORK to "mainnet" for production.                ║
// ║                                                              ║
// ║  Sensitive values (RPC URLs with API keys, keystore,        ║
// ║  password) live in /secrets/ and are NOT in this file.      ║
// ╚══════════════════════════════════════════════════════════════╝

// ─────────────────────────────────────────────────────────────────
//  Network selection
// ─────────────────────────────────────────────────────────────────

export const NETWORK = "testnet"; // "testnet" or "mainnet"

// ─────────────────────────────────────────────────────────────────
//  Network-specific addresses
// ─────────────────────────────────────────────────────────────────

const NETWORKS = {
  testnet: {
    chainId: 11155111,
    name: "sepolia",
    explorer: "https://sepolia.etherscan.io",
    contracts: {
      otusdt: "0x8b17e97e2760DB9C7FF25Ef0492aE3C883768905",
      gateway: "0xaaE4972BEb4501de6202Bae9c7bc775E0787f0d5",
      ethUsdFeed: "0x694AA1769357215DE4FAC081bf1f309aDC325306",
    },
  },
  mainnet: {
    chainId: 1,
    name: "mainnet",
    explorer: "https://etherscan.io",
    contracts: {
      otusdt: "PASTE_MAINNET_TOKEN_ADDRESS",
      gateway: "PASTE_MAINNET_GATEWAY_ADDRESS",
      ethUsdFeed: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
    },
  },
}; 

export const NET = NETWORKS[NETWORK];

// ─────────────────────────────────────────────────────────────────
//  Ignore list
// ─────────────────────────────────────────────────────────────────
// Transfer events where `from` or `to` is any of these addresses
// will be skipped. The bot never attempts to lock these wallets.
//
// The OTUSDT contract itself and the gateway contract are added
// automatically from NET.contracts above. Add any additional system
// wallets (owner, smart contract, platform, treasury) here.
// ─────────────────────────────────────────────────────────────────

export const SYSTEM_WALLETS = {
  // Fill these in with the actual deployed wallet addresses.
  // All addresses will be lowercased internally for comparison.
  owner: "0x067A04FC21c5FabA1a830b2683fff9ff9d458eEe",
  smartContract: "0x7792b7cA7f6a6871199ff23Aad824D2C595d3dE4",
  platform: "0x3c4DB40108286e0C7e3D3ac695D110c3A1e11398",
  treasury: null, // set this when the redemption flow ships, leave null for now
};

// ─────────────────────────────────────────────────────────────────
//  Gas spend controls
// ─────────────────────────────────────────────────────────────────
// MAX_GAS_USD is the hard ceiling the bot will spend per lockWallet
// transaction. If current network gas would cost more than this,
// the bot queues the wallet and waits for gas to drop.
//
// Adjust freely. Effect is immediate on next drain loop iteration.
// ─────────────────────────────────────────────────────────────────

export const MAX_GAS_USD = 2.0;

// Estimated gas units per lockWallet call. Actual is ~45-55k.
// We use 60000 in the ceiling math as a safety buffer so the real
// transaction never blows through the USD cap.
export const LOCK_GAS_UNITS = 60000n;

// Priority tip added on top of base fee. Higher tip = faster inclusion
// but higher cost. 1.5 gwei is aggressive enough to land in the next
// block under normal conditions.
export const PRIORITY_TIP_GWEI = 1.5;

// How often the drain loop checks if queued locks can now fire.
// 30 seconds is a good balance between responsiveness and RPC spend.
export const DRAIN_INTERVAL_MS = 30_000;

// How often we refresh the Chainlink ETH/USD price.
// Chainlink updates on ~1 hour heartbeat, so 5 min is plenty.
export const PRICE_REFRESH_MS = 5 * 60_000;

// ─────────────────────────────────────────────────────────────────
//  Catch-up and dedup
// ─────────────────────────────────────────────────────────────────

// On boot, we re-scan from (lastProcessedBlock - CATCHUP_OVERLAP) to
// handle reorgs and edge cases. Dedup ensures no duplicate processing.
export const CATCHUP_OVERLAP = 5;

// Max entries in the in-memory dedup set. Events are keyed by
// txHash:logIndex. 10000 covers more than a day of typical volume.
export const DEDUP_CACHE_SIZE = 10_000;

// If neither provider delivers an event for this many milliseconds,
// the watchdog kicks both reconnect routines.
export const WATCHDOG_SILENCE_MS = 60_000;

// ─────────────────────────────────────────────────────────────────
//  Filesystem paths
// ─────────────────────────────────────────────────────────────────

export const PATHS = {
  // Persistent state file. Survives restarts.
  state: "./data/state.json",

  // Secrets directory. Mounted as a volume in Docker, NOT copied
  // into the image. All three files inside are chmod 600.
  secretsDir: "/secrets",
  keystoreFile: "owner.keystore.json",
  passwordFile: "owner.password",
  providersFile: "providers.json",
};

// ─────────────────────────────────────────────────────────────────
//  Logging
// ─────────────────────────────────────────────────────────────────

export const LOG_LEVEL = "info"; // "debug" | "info" | "warn" | "error"
