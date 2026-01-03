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
import { requireToken } from "../config/tokens.js";
import {
  DEFAULT_LZ_COMPOSE_GAS,
  DEFAULT_LZ_RECEIVE_GAS,
  addressToBytes32,
  buildComposeMsg,
  buildLzComposeOptions,
  getArg,
  getPositionalArg,
  hasFlag,
  resolveHyperEvmRpcUrl,
  resolvePrivateKey,
  resolveUnwrapComposerAddress
} from "./utils.js";

const BSC_DST_EID = 30102;

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
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }
] as const;

const ioftAbi = [
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
    output.write(
      `\nAbout to execute HyperEVM -> Underlying (compose unwrap):\n${JSON.stringify(summary, null, 2)}\n\n`
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

  const to = getArg("--to");
  if (!to || !isAddress(to)) throw new Error("Missing/invalid --to (BSC recipient address)");

  const amountHuman = getArg("--amount");
  if (!amountHuman) throw new Error("Missing --amount (human readable, e.g. 0.5)");

  const composerOverride = getArg("--unwrap-composer") ?? getArg("--unwrap-composer-address");
  const unwrapComposer = resolveUnwrapComposerAddress(tokenMeta, composerOverride);

  const rpcUrl = resolveHyperEvmRpcUrl();
  const privateKey = resolvePrivateKey();
  const account = privateKeyToAccount(privateKey);

  const publicClient = createPublicClient({ transport: http(rpcUrl) });
  const chainId = await publicClient.getChainId();
  if (chainId !== 999) throw new Error(`Expected HyperEVM (chainId=999), got chainId=${chainId}`);

  const chain: Chain = HYPE_EVM_CHAIN;
  const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });

  const oftAddress = tokenMeta.hyperEvm.oft;

  const decimals = await publicClient.readContract({
    address: oftAddress,
    abi: erc20Abi,
    functionName: "decimals"
  });

  const amountLD = parseUnits(amountHuman, decimals);
  const minAmountLD = amountLD;

  const balance = await publicClient.readContract({
    address: oftAddress,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account.address]
  });

  if (balance < amountLD) {
    throw new Error(`Insufficient balance on HyperEVM: have ${balance.toString()}, want ${amountLD.toString()}`);
  }

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
  let composeMsg = composeMsgArg ? (composeMsgArg as Hex) : buildComposeMsg(to as Address);
  if (composeMsg === "0x") composeMsg = "0x01";

  const sendParam = {
    dstEid: BSC_DST_EID,
    to: addressToBytes32(unwrapComposer),
    amountLD,
    minAmountLD,
    extraOptions,
    composeMsg,
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
    signer: account.address,
    oftAddress,
    unwrapComposer,
    to,
    dstEid: BSC_DST_EID,
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
