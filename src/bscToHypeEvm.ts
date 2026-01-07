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
import { bsc } from "viem/chains";
import { requireToken } from "./config/tokens.js";

function hasFlag(flag: string) {
  return process.argv.includes(flag);
}

function getArg(name: string): string | undefined {
  const idx = process.argv.findIndex((a) => a === name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function getPositionalArg(index: number): string | undefined {
  // Example: `npm run sendToHyperEvm -- CRCLd --to ... --amount ...`
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
      `\nAbout to execute LayerZero OFT send:\n${JSON.stringify(summary, null, 2)}\n\n`
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
  // left-pad 20-byte address to 32 bytes
  return padHex(addr, { size: 32 });
}

type NamedAddress = {
  name: string; // normalized (lowercase)
  chainId: number;
  address: `0x${string}`;
};

// Token name -> OFT/Adapter address on the SOURCE chain.
// For your deployment: on BSC, "CRCLd" routes through the DStockOFTAdapter.
const KNOWN_OFT_BY_CHAIN: NamedAddress[] = [
  { name: "crcld", chainId: 56, address: "0xF351FA44A73E6D1E9c4C2927A8D2b8c69a8B8897" }
];

function normalizeName(s: string) {
  return s.trim().toLowerCase();
}

function listKnownTokens(chainId: number) {
  return KNOWN_OFT_BY_CHAIN.filter((t) => t.chainId === chainId).map((t) => t.name);
}

function resolveOftAddress(input: string | undefined, chainId: number): `0x${string}` {
  if (!input) {
    throw new Error(
      'Missing token/OFT. Usage: `npm run sendToHyperEvm -- <TOKEN> --to <ADDR> --amount <HUMAN> [--yes]` (e.g. CRCLd)'
    );
  }
  if (isAddress(input)) return input as `0x${string}`;

  const name = normalizeName(input);
  const match = KNOWN_OFT_BY_CHAIN.find((t) => t.chainId === chainId && t.name === name);
  if (!match) {
    const known = listKnownTokens(chainId);
    const hint = known.length ? `Known tokens on this chain: ${known.join(", ")}` : "No known tokens configured for this chain.";
    throw new Error(`Unknown token name: ${input}. ${hint}`);
  }
  return match.address;
}

// =============================
// Defaults (edit these for your deployment)
// =============================
const DEFAULT_DST_EID = 30367;

// Minimal ABIs (no hardhat artifacts required)
const erc20Abi = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
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
  const rpcUrl = env("SRC_RPC_URL");
  if (!rpcUrl) throw new Error("Missing SRC_RPC_URL");

  const privateKey = env("PRIVATE_KEY") as `0x${string}` | undefined;
  if (!privateKey) throw new Error("Missing PRIVATE_KEY");

  const dstEid = DEFAULT_DST_EID;

  // Command-line needs receiver + amount.
  const to = getArg("--to") as `0x${string}` | undefined;
  if (!to || !isAddress(to)) throw new Error("Missing/invalid --to (or TO)");

  const amountHuman = getArg("--amount");
  if (!amountHuman) throw new Error("Missing --amount (human readable, e.g. 0.5)");

  const minAmountHuman = amountHuman;

  // Optional, pass-through (already encoded) - kept as hardcoded defaults for now.
  const extraOptionsHex = "0x" as Hex;
  const composeMsgHex = "0x" as Hex;
  const oftCmdHex = "0x" as Hex;

  const account = privateKeyToAccount(privateKey);

  const publicClient = createPublicClient({ transport: http(rpcUrl) });
  const chainId = await publicClient.getChainId();
  if (chainId !== 56) throw new Error(`sendToHyperEvm expects BSC RPC (chainId=56), got chainId=${chainId}`);
  const chain: Chain = bsc;
  const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });

  // Require token/OFT selection from CLI (do not rely on env defaults).
  // Supports either `--token <NAME|ADDRESS>` / `--oft <NAME|ADDRESS>` or a positional arg: `<NAME|ADDRESS>`
  const tokenInput = getArg("--token") ?? getArg("--oft") ?? getPositionalArg(0);
  const token = requireToken(tokenInput);
  const oftAddress = token.bsc.adapter;

  const underlying = (await publicClient.readContract({
    address: oftAddress,
    abi: ioftAbi,
    functionName: "token"
  })) as `0x${string}`;

  const decimals = await publicClient.readContract({
    address: underlying,
    abi: erc20Abi,
    functionName: "decimals"
  });

  const amountLD = parseUnits(amountHuman, decimals);
  const minAmountLD = parseUnits(minAmountHuman, decimals);

  // approvalRequired() exists for adapters; if call fails, assume no approval required.
  let approvalRequired = false;
  try {
    approvalRequired = await publicClient.readContract({
      address: oftAddress,
      abi: ioftAbi,
      functionName: "approvalRequired"
    });
  } catch {
    approvalRequired = false;
  }

  if (approvalRequired) {
    const allowance = await publicClient.readContract({
      address: underlying,
      abi: erc20Abi,
      functionName: "allowance",
      args: [account.address, oftAddress]
    });

    if (allowance < amountLD) {
      const approveHash = await walletClient.writeContract({
        address: underlying,
        abi: erc20Abi,
        functionName: "approve",
            args: [oftAddress, amountLD]
      });
      console.log("approve tx =", approveHash);
      await publicClient.waitForTransactionReceipt({ hash: approveHash });
      console.log("approve confirmed");
    }
  }

  const sendParam = {
    dstEid: dstEid,
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
    underlying,
    decimals,
    dstEid,
    to,
    amountHuman,
    minAmountHuman,
    amountLD: amountLD.toString(),
    minAmountLD: minAmountLD.toString(),
    extraOptionsHex,
    nativeFee: msgFee.nativeFee.toString(),
    lzTokenFee: msgFee.lzTokenFee.toString()
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
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


