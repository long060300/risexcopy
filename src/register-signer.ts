import "dotenv/config";
import { ExchangeClient } from "risex-client";
import { Wallet } from "ethers";

// ── One-time signer registration ────────────────────────────
// Reads your MAIN wallet key from .env, generates a fresh signer key,
// registers it on-chain, and prints the signer key to put in .env.
//
// .env must contain:
//   ACCOUNT_ADDRESS=0x...            (your main trading wallet address)
//   ACCOUNT_PRIVATE_KEY=0x...        (your main wallet private key — used ONCE)
//
// Run:  npx ts-node src/register-signer.ts

const ACCOUNT_ADDRESS = process.env.ACCOUNT_ADDRESS!;
const ACCOUNT_PRIVATE_KEY = process.env.ACCOUNT_PRIVATE_KEY!;
const RISEX_API_URL = process.env.RISEX_API_URL || "https://api.rise.trade";
const RISEX_WS_URL = process.env.RISEX_WS_URL || "wss://ws.rise.trade/ws";

// Reuse an existing signer key if you already have one in .env, else generate.
const EXISTING_SIGNER = process.env.SIGNER_PRIVATE_KEY;

async function main() {
  if (!ACCOUNT_ADDRESS || !ACCOUNT_PRIVATE_KEY) {
    console.error(
      "Missing ACCOUNT_ADDRESS or ACCOUNT_PRIVATE_KEY in .env\n" +
      "Add your MAIN wallet private key as ACCOUNT_PRIVATE_KEY (used once to register)."
    );
    process.exit(1);
  }

  // Use existing signer key if present, otherwise create a fresh one
  const signerWallet = EXISTING_SIGNER
    ? new Wallet(EXISTING_SIGNER)
    : Wallet.createRandom();

  console.log("=== RISEx Signer Registration ===");
  console.log(`Account:      ${ACCOUNT_ADDRESS}`);
  console.log(`Signer addr:  ${signerWallet.address}`);
  console.log(`Reusing key:  ${EXISTING_SIGNER ? "yes (from SIGNER_PRIVATE_KEY)" : "no (generated new)"}`);
  console.log();

  const exchange = new ExchangeClient({
    baseUrl: RISEX_API_URL,
    wsUrl: RISEX_WS_URL,
    account: ACCOUNT_ADDRESS,
    accountKey: ACCOUNT_PRIVATE_KEY,
    signerKey: signerWallet.privateKey,
    logLevel: "info",
  });

  await exchange.init();
  console.log("Client initialized, checking current status...");

  const already = await exchange.isSignerRegistered();
  if (already) {
    console.log("\n✓ This signer is ALREADY registered. Nothing to do.");
    printEnv(signerWallet.privateKey);
    return;
  }

  console.log("Registering signer on-chain...");
  const result = await exchange.registerSigner("copybot");
  console.log("Register result:", JSON.stringify(result));

  // Verify
  const ok = await exchange.isSignerRegistered();
  if (ok) {
    console.log("\n✓ SUCCESS — signer is now registered and authorized.");
    printEnv(signerWallet.privateKey);
  } else {
    console.log("\n⚠️  Registration call sent but isSignerRegistered() still false.");
    console.log("It may take a few seconds to confirm on-chain. Re-run the bot shortly.");
    printEnv(signerWallet.privateKey);
  }
}

function printEnv(signerKey: string) {
  console.log("\n──────────────────────────────────────────────");
  console.log("Put this in your .env (and REMOVE ACCOUNT_PRIVATE_KEY after):");
  console.log(`SIGNER_PRIVATE_KEY=${signerKey}`);
  console.log("──────────────────────────────────────────────");
}

main().catch((err) => {
  console.error("Registration failed:", err);
  process.exit(1);
});
