import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  createPublicClient,
  createWalletClient,
  http,
  isAddress,
  parseUnits,
  type Chain,
  type Hex
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";
import { requireToken } from "../config/tokens.js";
import {
  DEFAULT_LZ_COMPOSE_GAS,
  DEFAULT_LZ_RECEIVE_GAS,
  HYPEREVM_EID,
  addressToBytes32,
  buildComposeMsg,
  buildLzComposeOptions,
  getArg,
  getPositionalArg,
  hasFlag,
  resolveBscRpcUrl,
  resolveComposerAddress,
  resolvePrivateKey
} from "./utils.js";

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
    outputs: []
  }
] as const;

function parseNumberArg(value: string | undefined, label: string): number | undefined {
  if (value == null) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${label}: ${value}`);
  return parsed;
}

async function confirmOrExit(summary: unknown) {
  if (hasFlag("--yes")) return;
  const rl = createInterface({ input, output });
  try {
    output.write(`\nAbout to execute Adapter send + compose:\n${JSON.stringify(summary, null, 2)}\n\n`);
    const ans = (await rl.question('Type "YES" to confirm: ')).trim();
    if (ans !== "YES") {
      console.log("Cancelled.");
      process.exit(1);
    }
  } finally {
    rl.close();
  }
}

async function main() {
  const tokenInput = getArg("--token") ?? getPositionalArg(0);
  const tokenMeta = requireToken(tokenInput);

  const amountHuman = getArg("--amount");
  if (!amountHuman) throw new Error("Missing --amount (human readable, e.g. 1.0)");

  const composerOverride = getArg("--composer") ?? getArg("--composer-address");
  const composerAddress = resolveComposerAddress(tokenMeta, composerOverride);

  const rpcUrl = resolveBscRpcUrl();
  const privateKey = resolvePrivateKey();
  const account = privateKeyToAccount(privateKey);

  const publicClient = createPublicClient({ chain: bsc, transport: http(rpcUrl) });
  const chainId = await publicClient.getChainId();
  if (chainId !== 56) throw new Error(`Expected BSC RPC (chainId=56), got chainId=${chainId}`);

  const chain: Chain = bsc;
  const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });

  const oftAddress = tokenMeta.bsc.adapter;

  const underlying = await publicClient.readContract({
    address: oftAddress,
    abi: ioftAbi,
    functionName: "token"
  });

  const decimals = await publicClient.readContract({
    address: underlying,
    abi: erc20Abi,
    functionName: "decimals"
  });

  const amountLD = parseUnits(amountHuman, decimals);
  const minAmountLD = amountLD;

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

  const dstEid = Number(getArg("--dst-eid") ?? HYPEREVM_EID);
  if (!Number.isFinite(dstEid)) throw new Error("Invalid --dst-eid");

  const receiver = getArg("--to") ?? account.address;
  if (!isAddress(receiver)) throw new Error("Invalid --to (HyperCore recipient)");

  const extraOptionsArg = getArg("--extra-options");
  const receiveGas = parseNumberArg(getArg("--lz-receive-gas"), "--lz-receive-gas") ?? DEFAULT_LZ_RECEIVE_GAS;
  const receiveValue = parseNumberArg(getArg("--lz-receive-value"), "--lz-receive-value") ?? 0;
  const composeGas = parseNumberArg(getArg("--lz-compose-gas"), "--lz-compose-gas") ?? DEFAULT_LZ_COMPOSE_GAS;
  const composeValue = parseNumberArg(getArg("--lz-compose-value"), "--lz-compose-value") ?? 0;
  const composeIndex = parseNumberArg(getArg("--lz-compose-index"), "--lz-compose-index") ?? 0;

  let extraOptions = "0x" as Hex;
  if (extraOptionsArg) {
    extraOptions = extraOptionsArg as Hex;
  } else {
    extraOptions = buildLzComposeOptions({
      receiveGas,
      receiveValue,
      composeGas,
      composeValue,
      composeIndex
    });
  }

  const composeMsgArg = getArg("--compose-msg");
  let composeMsg = composeMsgArg ? (composeMsgArg as Hex) : buildComposeMsg(receiver as `0x${string}`);
  if (composeMsg === "0x") composeMsg = "0x01";

  const sendParam = {
    dstEid: dstEid,
    to: addressToBytes32(composerAddress),
    amountLD: amountLD,
    minAmountLD: minAmountLD,
    extraOptions: extraOptions,
    composeMsg: composeMsg,
    oftCmd: "0x" as Hex
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
    oftAddress,
    token: tokenMeta.name,
    underlying,
    composerAddress,
    receiver,
    dstEid,
    amountHuman,
    amountLD: amountLD.toString(),
    extraOptions,
    composeMsg,
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
