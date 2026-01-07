import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  createPublicClient,
  createWalletClient,
  http,
  isAddress,
  padHex,
  parseUnits,
  type Chain,
  type Hex
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { requireToken } from "./config/tokens.js";

function hasFlag(flag: string) {
  return process.argv.includes(flag);
}

function getArg(name: string): string | undefined {
  const idx = process.argv.findIndex((a) => a === name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function getPositionalArg(index: number): string | undefined {
  const argv = process.argv.slice(2);
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    if (a.startsWith("-")) {
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) i++;
      continue;
    }
    positionals.push(a);
  }
  return positionals[index];
}

async function confirmOrExit(summary: unknown) {
  // Skip confirmation by default; only prompt if --confirm is passed (and --yes is not)
  if (!hasFlag("--confirm") || hasFlag("--yes")) return;
  const rl = createInterface({ input, output });
  try {
    output.write(
      `\nAbout to execute LayerZero OFT send (HyperEVM -> BSC):\n${JSON.stringify(summary, null, 2)}\n\n`
    );
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

function toBytes32Address(addr: Hex): Hex {
  return padHex(addr, { size: 32 });
}

// LayerZero Endpoint ID for BSC
const BSC_DST_EID = 30102;

// HyperEVM chain config
const HYPE_EVM_CHAIN: Chain = {
  id: 999,
  name: "HyperEVM",
  nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.hyperliquid.xyz/evm"] },
    public: { http: ["https://rpc.hyperliquid.xyz/evm"] }
  }
};

const erc20Abi = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { type: "address", name: "owner" },
      { type: "address", name: "spender" }
    ],
    outputs: [{ type: "uint256" }]
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { type: "address", name: "spender" },
      { type: "uint256", name: "amount" }
    ],
    outputs: [{ type: "bool" }]
  }
] as const;

const ioftAbi = [
  { type: "function", name: "token", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  {
    type: "function",
    name: "approvalRequired",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bool" }]
  },
  {
    type: "function",
    name: "quoteSend",
    stateMutability: "view",
    inputs: [
      {
        name: "_sendParam",
        type: "tuple",
        components: [
          { name: "dstEid", type: "uint32" },
          { name: "to", type: "bytes32" },
          { name: "amountLD", type: "uint256" },
          { name: "minAmountLD", type: "uint256" },
          { name: "extraOptions", type: "bytes" },
          { name: "composeMsg", type: "bytes" },
          { name: "oftCmd", type: "bytes" }
        ]
      },
      { name: "_payInLzToken", type: "bool" }
    ],
    outputs: [
      {
        name: "msgFee",
        type: "tuple",
        components: [
          { name: "nativeFee", type: "uint256" },
          { name: "lzTokenFee", type: "uint256" }
        ]
      }
    ]
  },
  {
    type: "function",
    name: "send",
    stateMutability: "payable",
    inputs: [
      {
        name: "_sendParam",
        type: "tuple",
        components: [
          { name: "dstEid", type: "uint32" },
          { name: "to", type: "bytes32" },
          { name: "amountLD", type: "uint256" },
          { name: "minAmountLD", type: "uint256" },
          { name: "extraOptions", type: "bytes" },
          { name: "composeMsg", type: "bytes" },
          { name: "oftCmd", type: "bytes" }
        ]
      },
      {
        name: "_fee",
        type: "tuple",
        components: [
          { name: "nativeFee", type: "uint256" },
          { name: "lzTokenFee", type: "uint256" }
        ]
      },
      { name: "_refundAddress", type: "address" }
    ],
    outputs: [
      {
        name: "msgReceipt",
        type: "tuple",
        components: [
          { name: "guid", type: "bytes32" },
          { name: "nonce", type: "uint64" },
          {
            name: "fee",
            type: "tuple",
            components: [
              { name: "nativeFee", type: "uint256" },
              { name: "lzTokenFee", type: "uint256" }
            ]
          }
        ]
      },
      {
        name: "oftReceipt",
        type: "tuple",
        components: [
          { name: "amountSentLD", type: "uint256" },
          { name: "amountReceivedLD", type: "uint256" }
        ]
      }
    ]
  }
] as const;

async function main() {
  const rpcUrl = "https://rpc.hyperliquid.xyz/evm";

  const privateKey = env("PRIVATE_KEY") as `0x${string}` | undefined;
  if (!privateKey) throw new Error("Missing PRIVATE_KEY");

  // Destination on BSC
  const to = getArg("--to") as `0x${string}` | undefined;
  if (!to || !isAddress(to)) throw new Error("Missing/invalid --to (BSC destination address)");

  const amountHuman = getArg("--amount");
  if (!amountHuman) throw new Error("Missing --amount (human readable, e.g. 0.5)");

  const minAmountHuman = amountHuman;

  const extraOptionsHex = "0x" as Hex;
  const composeMsgHex = "0x" as Hex;
  const oftCmdHex = "0x" as Hex;

  const account = privateKeyToAccount(privateKey);

  const publicClient = createPublicClient({ transport: http(rpcUrl) });
  const chainId = await publicClient.getChainId();
  if (chainId !== 999) throw new Error(`Expected HyperEVM (chainId=999), got chainId=${chainId}`);

  const walletClient = createWalletClient({ account, chain: HYPE_EVM_CHAIN, transport: http(rpcUrl) });

  // Token selection
  const tokenInput = getArg("--token") ?? getArg("--oft") ?? getPositionalArg(0);
  const token = requireToken(tokenInput);
  
  // On HyperEVM, the OFT address is the token itself (not an adapter)
  const oftAddress = token.hyperEvm.oft;

  // For DStockOFT on HyperEVM, the token() function returns the OFT address itself
  // (it's not an adapter pattern like on BSC)
  const decimals = await publicClient.readContract({
    address: oftAddress,
    abi: erc20Abi,
    functionName: "decimals"
  });

  const amountLD = parseUnits(amountHuman, decimals);
  const minAmountLD = parseUnits(minAmountHuman, decimals);

  // Check balance
  const balance = await publicClient.readContract({
    address: oftAddress,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account.address]
  });

  if (balance < amountLD) {
    throw new Error(
      `Insufficient balance on HyperEVM: have ${balance.toString()} wei, want ${amountLD.toString()} wei`
    );
  }

  // Check native HYPE balance for gas
  const nativeBalance = await publicClient.getBalance({ address: account.address });
  const minGasWei = parseUnits("0.01", 18);
  if (nativeBalance < minGasWei) {
    throw new Error(
      `Insufficient native HYPE for gas: have ${nativeBalance.toString()} wei (< 0.01 HYPE)`
    );
  }

  const sendParam = {
    dstEid: BSC_DST_EID,
    to: toBytes32Address(to),
    amountLD,
    minAmountLD,
    extraOptions: extraOptionsHex,
    composeMsg: composeMsgHex,
    oftCmd: oftCmdHex
  } as const;

  const msgFee = await publicClient.readContract({
    address: oftAddress,
    abi: ioftAbi,
    functionName: "quoteSend",
    args: [sendParam, false]
  });

  const summary = {
    rpcUrl,
    chainId,
    signer: account.address,
    oftAddress,
    decimals,
    dstEid: BSC_DST_EID,
    to,
    amountHuman,
    minAmountHuman,
    amountLD: amountLD.toString(),
    minAmountLD: minAmountLD.toString(),
    balanceWei: balance.toString(),
    nativeHypeWei: nativeBalance.toString(),
    nativeFee: msgFee.nativeFee.toString(),
    lzTokenFee: msgFee.lzTokenFee.toString(),
    note: "This sends tokens from HyperEVM to BSC via LayerZero"
  };

  if (hasFlag("--dry-run")) {
    console.log(JSON.stringify(summary, null, 2));
    console.log("dry-run: not sending.");
    return;
  }

  await confirmOrExit(summary);

  const hash = await walletClient.writeContract({
    address: oftAddress,
    abi: ioftAbi,
    functionName: "send",
    args: [sendParam, msgFee, account.address],
    value: msgFee.nativeFee
  });

  console.log("send tx =", hash);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log("confirmed in block", receipt.blockNumber);
  console.log(`\nSuccessfully initiated cross-chain transfer of ${amountHuman} ${token.name} from HyperEVM to BSC`);
  console.log(`Destination: ${to}`);
  console.log("\nNote: LayerZero cross-chain messages typically take a few minutes to finalize on BSC.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

