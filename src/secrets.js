import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Wallet } from "ethers";
import { PATHS } from "../config.js";
import { childLogger } from "./logger.js";

const log = childLogger("secrets");

/**
 * Loads and decrypts the owner wallet keystore.
 *
 * Reads two files from the secrets directory:
 *   1. owner.keystore.json - standard Ethereum keystore v3 JSON
 *   2. owner.password - plaintext password for the keystore
 *
 * Both files must have chmod 600 permissions. Neither file ever
 * touches stdout, logs, env vars, or disk outside the mounted
 * secrets volume.
 *
 * Throws if either file is missing, unreadable, or decryption fails.
 *
 * @returns {Promise<Wallet>} Decrypted ethers Wallet instance
 */
export async function loadOwnerWallet() {
  const keystorePath = join(PATHS.secretsDir, PATHS.keystoreFile);
  const passwordPath = join(PATHS.secretsDir, PATHS.passwordFile);

  let keystoreJson;
  try {
    keystoreJson = await readFile(keystorePath, "utf8");
  } catch (err) {
    log.error({ path: keystorePath }, "keystore file not readable");
    throw new Error(`Cannot read keystore at ${keystorePath}: ${err.message}`);
  }

  let password;
  try {
    password = (await readFile(passwordPath, "utf8")).trim();
  } catch (err) {
    log.error({ path: passwordPath }, "password file not readable");
    throw new Error(`Cannot read password at ${passwordPath}: ${err.message}`);
  }

  if (!password) {
    throw new Error(`Password file at ${passwordPath} is empty`);
  }

  let wallet;
  try {
    wallet = await Wallet.fromEncryptedJson(keystoreJson, password);
  } catch (err) {
    // Wipe password from memory reference asap on failure.
    password = null;
    log.error("keystore decryption failed (wrong password or corrupt file)");
    throw new Error(`Keystore decryption failed: ${err.message}`);
  }

  // Password is no longer needed; drop the local reference so the
  // garbage collector can reclaim the buffer sooner.
  password = null;

  log.info({ address: wallet.address }, "owner wallet decrypted");
  return wallet;
}

/**
 * Loads RPC provider URLs from the secrets directory.
 *
 * Reads providers.json which must contain:
 *   {
 *     "alchemyWssUrl": "wss://eth-mainnet.g.alchemy.com/v2/YOUR_KEY",
 *     "infuraWssUrl":  "wss://mainnet.infura.io/ws/v3/YOUR_PROJECT_ID"
 *   }
 *
 * These URLs contain API keys embedded in the path, so they are
 * treated as sensitive and kept outside the repo and image.
 *
 * @returns {Promise<{alchemyWssUrl: string, infuraWssUrl: string}>}
 */
export async function loadProviderUrls() {
  const path = join(PATHS.secretsDir, PATHS.providersFile);

  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    log.error({ path }, "providers file not readable");
    throw new Error(`Cannot read providers file at ${path}: ${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in providers file: ${err.message}`);
  }

  if (!parsed.alchemyWssUrl || !parsed.infuraWssUrl) {
    throw new Error(
      "providers.json must contain both 'alchemyWssUrl' and 'infuraWssUrl'"
    );
  }

  log.info("provider URLs loaded");
  return {
    alchemyWssUrl: parsed.alchemyWssUrl,
    infuraWssUrl: parsed.infuraWssUrl,
  };
}
