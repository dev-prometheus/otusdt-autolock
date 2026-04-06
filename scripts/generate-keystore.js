#!/usr/bin/env node
/**
 * Generates an encrypted ethers keystore v3 JSON file from a raw
 * private key and a password.
 *
 * Run this ONCE on your local machine, never on the server.
 * After running, upload the resulting keystore file and a separate
 * password file to the server via SCP, chmod 600, and never commit
 * either one to git.
 *
 * USAGE:
 *   node scripts/generate-keystore.js
 *
 * You will be prompted for:
 *   1. The raw private key (64 hex chars, with or without 0x prefix)
 *   2. A password (shown while typing - run this on a trusted machine)
 *   3. An output path (default: ./owner.keystore.json)
 *
 * After the keystore is generated, also create the password file:
 *   echo -n "yourpassword" > ./owner.password
 *   chmod 600 ./owner.password ./owner.keystore.json
 *
 * Then SCP both files into the Coolify secrets volume.
 */

import { Wallet } from "ethers";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function main() {
  console.log("\n━━━━ OTUSDT Auto-Lock Bot: Keystore Generator ━━━━\n");
  console.log("This will create an encrypted keystore file from your");
  console.log("raw private key. Run this ONLY on your local machine.\n");

  let rawKey = (await prompt("Private key (hex): ")).trim();
  if (!rawKey) {
    console.error("ERROR: no private key provided");
    process.exit(1);
  }
  if (!rawKey.startsWith("0x")) rawKey = "0x" + rawKey;

  if (!/^0x[0-9a-fA-F]{64}$/.test(rawKey)) {
    console.error("ERROR: private key must be 64 hex characters");
    process.exit(1);
  }

  let wallet;
  try {
    wallet = new Wallet(rawKey);
  } catch (err) {
    console.error(`ERROR: invalid private key: ${err.message}`);
    process.exit(1);
  }

  console.log(`\nWallet address derived: ${wallet.address}`);
  console.log("Confirm this matches your expected owner wallet before continuing.\n");

  const confirmed = (await prompt("Address correct? (yes/no): ")).trim().toLowerCase();
  if (confirmed !== "yes" && confirmed !== "y") {
    console.log("Aborted.");
    process.exit(0);
  }

  const password = (await prompt("Password to encrypt keystore: ")).trim();
  if (!password || password.length < 8) {
    console.error("ERROR: password must be at least 8 characters");
    process.exit(1);
  }

  const confirmPassword = (await prompt("Confirm password: ")).trim();
  if (password !== confirmPassword) {
    console.error("ERROR: passwords do not match");
    process.exit(1);
  }

  const defaultOut = "./owner.keystore.json";
  const outPath = (await prompt(`Output path [${defaultOut}]: `)).trim() || defaultOut;

  console.log("\nEncrypting (this may take a few seconds)...");
  const json = await wallet.encrypt(password);

  await writeFile(outPath, json, "utf8");

  console.log(`\nKeystore written to: ${outPath}`);
  console.log("\nNext steps:");
  console.log(`  1. echo -n "${password.replace(/./g, "*")}" > ./owner.password`);
  console.log("     (use the real password, not asterisks)");
  console.log("  2. chmod 600 ./owner.keystore.json ./owner.password");
  console.log("  3. scp both files to your server's /secrets/ directory");
  console.log("  4. Also create providers.json in /secrets/ with your RPC URLs");
  console.log("  5. Never commit any of these files to git");
  console.log("\nDone.\n");
}

main().catch((err) => {
  console.error(`\nERROR: ${err.message}`);
  process.exit(1);
});
