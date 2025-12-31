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
  type Hex
} from "viem";
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

// =============================
// Defaults (edit these for your deployment)
// =============================
const DEFAULT_OFT_ADDRESS = "0xF351FA44A73E6D1E9c4C2927A8D2b8c69a8B8897" as const;
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
  const rpcUrl = env("SRC_RPC_URL") ?? env("RPC_URL") ?? env("RPC_URL_BSC_MAINNET");
  if (!rpcUrl) throw new Error("Missing SRC_RPC_URL (or RPC_URL / RPC_URL_BSC_MAINNET)");

  const privateKey = (env("PRIVATE_KEY") ?? env("HL_PRIVATE_KEY") ?? env("HL_AGENT_PRIVATE_KEY")) as
    | `0x${string}`
    | undefined;
  if (!privateKey) throw new Error("Missing PRIVATE_KEY (or HL_PRIVATE_KEY/HL_AGENT_PRIVATE_KEY)");

  // Allow overriding defaults via env, but you generally don't need to pass these on the command line.
  const oftAddress = (env("OFT_ADDRESS") ?? DEFAULT_OFT_ADDRESS) as `0x${string}`;
  if (!isAddress(oftAddress)) throw new Error(`Invalid OFT_ADDRESS: ${oftAddress}`);

  const dstEid = Number(env("DST_EID") ?? DEFAULT_DST_EID);
  if (!Number.isFinite(dstEid)) throw new Error(`Invalid DST_EID: ${String(env("DST_EID"))}`);

  // Command-line only needs receiver + amount (env still supported as fallback).
  const to = (getArg("--to") ?? env("TO")) as `0x${string}` | undefined;
  if (!to || !isAddress(to)) throw new Error("Missing/invalid --to (or TO)");

  const amountHuman = getArg("--amount") ?? env("AMOUNT");
  if (!amountHuman) throw new Error("Missing --amount (or AMOUNT) (human readable, e.g. 0.5)");

  const minAmountHuman = env("MIN_AMOUNT") ?? amountHuman;

  // Optional, pass-through (already encoded)
  const extraOptionsHex = (env("EXTRA_OPTIONS_HEX") ?? "0x") as Hex;
  const composeMsgHex = (env("COMPOSE_MSG_HEX") ?? "0x") as Hex;
  const oftCmdHex = (env("OFT_CMD_HEX") ?? "0x") as Hex;

  const account = privateKeyToAccount(privateKey);

  const publicClient = createPublicClient({ transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, transport: http(rpcUrl) });

  const chainId = await publicClient.getChainId();

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
        args: [oftAddress, amountLD],
        chain: undefined
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
    value: msgFee.nativeFee,
    chain: undefined
  });

  console.log("send tx =", hash);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log("confirmed in block", receipt.blockNumber);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


