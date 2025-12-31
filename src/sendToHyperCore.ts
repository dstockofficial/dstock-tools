import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { createPublicClient, createWalletClient, http, isAddress, parseUnits, type Address, type Chain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { requireToken } from "./config/tokens.js";
import { toAssetBridgeAddress } from "./config/hypercore.js";

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
    output.write(`\nAbout to transfer from HyperEVM -> HyperCore:\n${JSON.stringify(summary, null, 2)}\n\n`);
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

// Generic deposit address (legacy / native HYPE).
// For mapped spot assets, we derive the system/bridge address from tokenIndex.
const HYPERCORE_DEPOSIT_ADDRESS = "0x2222222222222222222222222222222222222222" as const;

const erc20Abi = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" }
    ],
    outputs: [{ type: "bool" }]
  }
] as const;

async function main() {
  const rpcUrl = "https://rpc.hyperliquid.xyz/evm";
  const chain: Chain = {
    id: 999,
    name: "HyperEVM",
    nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
    rpcUrls: {
      default: { http: [rpcUrl] },
      public: { http: [rpcUrl] }
    }
  };

  const privateKey = env("PRIVATE_KEY") as `0x${string}` | undefined;
  if (!privateKey) throw new Error("Missing PRIVATE_KEY");

  const tokenInput =
    getArg("--token") ??
    getArg("--asset") ??
    getArg("--symbol") ??
    process.argv.slice(2).find((a) => a && !a.startsWith("-"));
  if (!tokenInput) throw new Error("Missing token name (e.g. CRCLd).");

  const amountHuman = getArg("--amount");
  if (!amountHuman) throw new Error("Missing --amount (human readable, e.g. 1.25)");

  const account = privateKeyToAccount(privateKey);
  const publicClient = createPublicClient({ transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });

  const chainId = await publicClient.getChainId();
  if (chainId !== 999) throw new Error(`Unexpected chainId=${chainId}. Expected HyperEVM chainId=999.`);

  // We need tokenIndex to derive the HyperCore system/bridge address, so normal usage requires a known token name.
  // (Passing a raw ERC20 address is not supported here.)
  if (isAddress(tokenInput)) {
    throw new Error("Please pass a known token name (e.g. CRCLd) so we can derive the HyperCore bridge address from tokenIndex.");
  }

  const tokenMeta = requireToken(tokenInput);
  const tokenAddress: Address = tokenMeta.hyperEvm.oft;

  const depositAddress: Address =
    tokenMeta.hyperCore.depositAddress ?? toAssetBridgeAddress(tokenMeta.hyperCore.tokenIndex);

  const decimals = await publicClient.readContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: "decimals"
  });

  const amountWei = parseUnits(amountHuman, decimals);

  const balance = await publicClient.readContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account.address]
  });

  const summary = {
    rpcUrl,
    chainId,
    from: account.address,
    to: depositAddress,
    token: tokenMeta.name,
    tokenIndex: tokenMeta.hyperCore.tokenIndex,
    tokenAddress,
    amountHuman,
    amountWei: amountWei.toString(),
    balanceWei: balance.toString(),
    note:
      "This sends the HyperEVM token to the HyperCore system/bridge address derived from tokenIndex.",
    legacyDepositAddress: HYPERCORE_DEPOSIT_ADDRESS
  };

  if (hasFlag("--dry-run")) {
    console.log(JSON.stringify(summary, null, 2));
    console.log("dry-run: not sending.");
    return;
  }

  await confirmOrExit(summary);

  if (balance < amountWei) throw new Error("INSUFFICIENT_TOKEN_BALANCE_FOR_TRANSFER");

  const hash = await walletClient.writeContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: "transfer",
    args: [depositAddress, amountWei]
  });

  console.log("tx =", hash);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log("confirmed in block", receipt.blockNumber);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


