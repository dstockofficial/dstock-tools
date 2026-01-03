import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  createPublicClient,
  createWalletClient,
  http,
  isAddress,
  parseUnits,
  type Address,
  type Chain,
  type Hex
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";
import { requireToken } from "../config/tokens.js";
import {
  HYPEREVM_EID,
  addressToBytes32,
  buildLzReceiveOptions,
  getArg,
  getPositionalArg,
  hasFlag,
  resolveBscRpcUrl,
  resolvePrivateKey,
  resolveRouterAddress
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

const routerAbi = [
  {
    type: "function",
    name: "quoteWrapAndBridge",
    stateMutability: "view",
    inputs: [
      { name: "underlying", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "dstEid", type: "uint32" },
      { name: "to", type: "bytes32" },
      { name: "extraOptions", type: "bytes" }
    ],
    outputs: [{ name: "nativeFee", type: "uint256" }]
  },
  {
    type: "function",
    name: "wrapAndBridge",
    stateMutability: "payable",
    inputs: [
      { name: "underlying", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "dstEid", type: "uint32" },
      { name: "to", type: "bytes32" },
      { name: "extraOptions", type: "bytes" }
    ],
    outputs: [{ name: "amountSentLD", type: "uint256" }]
  }
] as const;

const MAX_UINT256 = (1n << 256n) - 1n;

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
    output.write(`\nAbout to execute Router wrap + bridge:\n${JSON.stringify(summary, null, 2)}\n\n`);
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

  const to = getArg("--to");
  if (!to || !isAddress(to)) throw new Error("Missing/invalid --to (HyperEVM recipient)");

  const amountHuman = getArg("--amount");
  if (!amountHuman) throw new Error("Missing --amount (human readable, e.g. 1.0)");

  const routerOverride = getArg("--router") ?? getArg("--router-address");
  const routerAddress = resolveRouterAddress(tokenMeta, routerOverride);

  const rpcUrl = resolveBscRpcUrl();
  const privateKey = resolvePrivateKey();
  const account = privateKeyToAccount(privateKey);

  const publicClient = createPublicClient({ chain: bsc, transport: http(rpcUrl) });
  const chainId = await publicClient.getChainId();
  if (chainId !== 56) throw new Error(`Expected BSC RPC (chainId=56), got chainId=${chainId}`);

  const chain: Chain = bsc;
  const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });

  const underlying = tokenMeta.bsc.underlying;
  if (!underlying) {
    throw new Error(
      `Missing underlying for ${tokenMeta.name}. Set token.bsc.underlying in src/config/tokens.ts or pass a different token.`
    );
  }

  const decimals = await publicClient.readContract({
    address: underlying,
    abi: erc20Abi,
    functionName: "decimals"
  });

  const amountWei = parseUnits(amountHuman, decimals);

  const allowance = await publicClient.readContract({
    address: underlying,
    abi: erc20Abi,
    functionName: "allowance",
    args: [account.address, routerAddress]
  });

  if (allowance < amountWei) {
    const approveHash = await walletClient.writeContract({
      address: underlying,
      abi: erc20Abi,
      functionName: "approve",
      args: [routerAddress, MAX_UINT256]
    });
    console.log("approve tx =", approveHash);
    await publicClient.waitForTransactionReceipt({ hash: approveHash });
    console.log("approve confirmed");
  }

  const dstEid = Number(getArg("--dst-eid") ?? HYPEREVM_EID);
  if (!Number.isFinite(dstEid)) throw new Error("Invalid --dst-eid");

  const extraOptionsArg = getArg("--extra-options");
  const lzReceiveGas = parseNumberArg(getArg("--lz-receive-gas"), "--lz-receive-gas");
  const lzReceiveValue = parseNumberArg(getArg("--lz-receive-value"), "--lz-receive-value") ?? 0;

  let extraOptions = "0x" as Hex;
  if (extraOptionsArg) {
    extraOptions = extraOptionsArg as Hex;
  } else if (lzReceiveGas != null) {
    extraOptions = buildLzReceiveOptions(lzReceiveGas, lzReceiveValue);
  }

  const toBytes32 = addressToBytes32(to as Address);

  const nativeFee = await publicClient.readContract({
    address: routerAddress,
    abi: routerAbi,
    functionName: "quoteWrapAndBridge",
    args: [underlying, amountWei, dstEid, toBytes32, extraOptions]
  });

  const summary = {
    rpcUrl,
    chainId,
    routerAddress,
    token: tokenMeta.name,
    underlying,
    to,
    dstEid,
    amountHuman,
    amountWei: amountWei.toString(),
    extraOptions,
    nativeFee: nativeFee.toString()
  };

  if (hasFlag("--dry-run")) {
    console.log(JSON.stringify(summary, null, 2));
    console.log("dry-run: not sending.");
    return;
  }

  await confirmOrExit(summary);

  const { request } = await publicClient.simulateContract({
    account,
    address: routerAddress,
    abi: routerAbi,
    functionName: "wrapAndBridge",
    args: [underlying, amountWei, dstEid, toBytes32, extraOptions],
    value: nativeFee
  });

  const hash = await walletClient.writeContract(request);
  console.log("wrapAndBridge tx =", hash);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log("confirmed in block", receipt.blockNumber);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
