import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { createPublicClient, createWalletClient, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";

function hasFlag(flag: string) {
  return process.argv.includes(flag);
}

function getArg(name: string): string | undefined {
  const idx = process.argv.findIndex((a) => a === name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

async function confirmOrExit(summary: unknown) {
  if (hasFlag("--yes")) return;
  const rl = createInterface({ input, output });
  try {
    output.write(`\nAbout to transfer HYPE from HyperEVM -> HyperCore:\n${JSON.stringify(summary, null, 2)}\n\n`);
    const ans = (await rl.question('Type "YES" to confirm: ')).trim();
    if (ans !== "YES") {
      console.log("Cancelled.");
      process.exit(1);
    }
  } finally {
    rl.close();
  }
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v != null && v !== "" ? v : undefined;
}

// Hyperliquid docs: sending native HYPE to this address credits your HyperCore spot balance.
// WARNING: This mechanism is intended for HYPE only; sending other assets may be lost.
const HYPERCORE_DEPOSIT_ADDRESS = "0x2222222222222222222222222222222222222222" as const;

async function main() {
  const rpcUrl =
    env("HYPEREVM_RPC_URL") ??
    env("HYPERLIQUID_EVM_RPC_URL") ??
    env("RPC_URL_HYPEREVM") ??
    env("RPC_URL") ??
    "https://rpc.hyperliquid.xyz/evm";

  const privateKey = (env("PRIVATE_KEY") ?? env("HL_PRIVATE_KEY") ?? env("HL_AGENT_PRIVATE_KEY")) as
    | `0x${string}`
    | undefined;
  if (!privateKey) throw new Error("Missing PRIVATE_KEY (or HL_PRIVATE_KEY/HL_AGENT_PRIVATE_KEY)");

  const amountHuman = getArg("--amount") ?? env("AMOUNT");
  if (!amountHuman) throw new Error("Missing --amount (or AMOUNT) (human readable, e.g. 1.25)");

  const account = privateKeyToAccount(privateKey);
  const publicClient = createPublicClient({ transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, transport: http(rpcUrl) });

  const chainId = await publicClient.getChainId();
  const value = parseUnits(amountHuman, 18);

  const balance = await publicClient.getBalance({ address: account.address });

  const summary = {
    rpcUrl,
    chainId,
    from: account.address,
    to: HYPERCORE_DEPOSIT_ADDRESS,
    amountHuman,
    valueWei: value.toString(),
    balanceWei: balance.toString(),
    warning: "This is intended for native HYPE only."
  };

  if (hasFlag("--dry-run")) {
    console.log(JSON.stringify(summary, null, 2));
    console.log("dry-run: not sending.");
    return;
  }

  await confirmOrExit(summary);

  if (balance < value) throw new Error("INSUFFICIENT_HYPE_BALANCE_FOR_TRANSFER");

  const hash = await walletClient.sendTransaction({
    to: HYPERCORE_DEPOSIT_ADDRESS,
    value,
    chain: undefined
  });

  console.log("tx =", hash);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log("confirmed in block", receipt.blockNumber);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


