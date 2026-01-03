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
    name: "quoteWrapAndBridgeCompose",
    stateMutability: "view",
    inputs: [
      { name: "underlying", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "dstEid", type: "uint32" },
      { name: "to", type: "bytes32" },
      { name: "extraOptions", type: "bytes" },
      { name: "composeMsg", type: "bytes" }
    ],
    outputs: [{ name: "nativeFee", type: "uint256" }]
  },
  {
    type: "function",
    name: "wrapAndBridgeCompose",
    stateMutability: "payable",
    inputs: [
      { name: "underlying", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "dstEid", type: "uint32" },
      { name: "to", type: "bytes32" },
      { name: "extraOptions", type: "bytes" },
      { name: "composeMsg", type: "bytes" }
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
    output.write(
      `\nAbout to execute Router wrap + bridge + compose:\n${JSON.stringify(summary, null, 2)}\n\n`
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

async function main() {
  const tokenInput = getArg("--token") ?? getPositionalArg(0);
  const tokenMeta = requireToken(tokenInput);

  const amountHuman = getArg("--amount");
  if (!amountHuman) throw new Error("Missing --amount (human readable, e.g. 1.0)");

  const routerOverride = getArg("--router") ?? getArg("--router-address");
  const routerAddress = resolveRouterAddress(tokenMeta, routerOverride);

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
  let composeMsg = composeMsgArg ? (composeMsgArg as Hex) : buildComposeMsg(receiver as Address);
  if (composeMsg === "0x") composeMsg = "0x01";

  const toBytes32 = addressToBytes32(composerAddress);

  const nativeFee = await publicClient.readContract({
    address: routerAddress,
    abi: routerAbi,
    functionName: "quoteWrapAndBridgeCompose",
    args: [underlying, amountWei, dstEid, toBytes32, extraOptions, composeMsg]
  });

  const summary = {
    rpcUrl,
    chainId,
    routerAddress,
    composerAddress,
    token: tokenMeta.name,
    underlying,
    receiver,
    dstEid,
    amountHuman,
    amountWei: amountWei.toString(),
    extraOptions,
    composeMsg,
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
    functionName: "wrapAndBridgeCompose",
    args: [underlying, amountWei, dstEid, toBytes32, extraOptions, composeMsg],
    value: nativeFee
  });

  const hash = await walletClient.writeContract(request);
  console.log("wrapAndBridgeCompose tx =", hash);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log("confirmed in block", receipt.blockNumber);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
