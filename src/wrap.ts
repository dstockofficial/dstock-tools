import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  createPublicClient,
  createWalletClient,
  http,
  isAddress,
  parseUnits,
  type Address
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

function hasFlag(flag: string) {
  return process.argv.includes(flag);
}

function getArg(name: string): string | undefined {
  const idx = process.argv.findIndex((a) => a === name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function getPositionalArg(index: number): string | undefined {
  // Returns the Nth positional arg after stripping out known flag patterns.
  // Example: `npm run wrap -- CRCLd --amount 1.0` => positional[0] = "CRCLd"
  const argv = process.argv.slice(2);
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    if (a.startsWith("-")) {
      // Skip flag value if present
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) i++;
      continue;
    }
    positionals.push(a);
  }
  return positionals[index];
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v != null && v !== "" ? v : undefined;
}

async function confirmOrExit(summary: unknown) {
  if (hasFlag("--yes")) return;
  const rl = createInterface({ input, output });
  try {
    output.write(`\nAbout to execute WRAP:\n${JSON.stringify(summary, null, 2)}\n\n`);
    const ans = (await rl.question('Type "YES" to confirm: ')).trim();
    if (ans !== "YES") {
      console.log("Cancelled.");
      process.exit(1);
    }
  } finally {
    rl.close();
  }
}

const MAX_UINT256 = (1n << 256n) - 1n;

type NamedAddress = {
  name: string; // normalized (lowercase) name
  chainId: number;
  address: Address;
};

const DEFAULT_COMPLIANCE_BY_CHAIN_ID: Record<number, Address> = {
  // BSC mainnet + Ethereum mainnet share the same Compliance in your deployment.
  56: "0xA0f16686BaaBF2AA81A56404B61560be89EaD271",
  1: "0xA0f16686BaaBF2AA81A56404B61560be89EaD271"
};

const KNOWN_WRAPPERS: NamedAddress[] = [
  // BSC mainnet wrappers
  { name: "crcld", chainId: 56, address: "0x8edE6AffCBe962e642f83d84b8Af66313A700dDf" }
];

function normalizeName(s: string) {
  return s.trim().toLowerCase();
}

function listKnownWrappers(chainId: number) {
  return KNOWN_WRAPPERS.filter((w) => w.chainId === chainId).map((w) => w.name);
}

function resolveWrapper(input: string | undefined, chainId: number): Address {
  if (!input) throw new Error("Missing WRAPPER (or --wrapper)");
  if (isAddress(input)) return input;

  const name = normalizeName(input);
  const match = KNOWN_WRAPPERS.find((w) => w.chainId === chainId && w.name === name);
  if (!match) {
    const known = listKnownWrappers(chainId);
    const hint = known.length ? `Known wrappers on this chain: ${known.join(", ")}` : "No known wrappers configured for this chain.";
    throw new Error(`Unknown wrapper name: ${input}. ${hint}`);
  }
  return match.address;
}

function resolveCompliance(input: string | undefined, chainId: number): Address {
  if (!input) {
    const fallback = DEFAULT_COMPLIANCE_BY_CHAIN_ID[chainId];
    if (!fallback) throw new Error("Missing COMPLIANCE (or --compliance) and no default is configured for this chainId.");
    return fallback;
  }
  if (!isAddress(input)) throw new Error("Invalid COMPLIANCE (or --compliance)");
  return input;
}

function requireAddress(input: string | undefined, label: string): Address {
  if (!input) throw new Error(`Missing ${label}`);
  if (!isAddress(input)) throw new Error(`Invalid ${label}`);
  return input;
}

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
      { type: "uint256", name: "value" }
    ],
    outputs: [{ type: "bool" }]
  }
] as const;

const wrapperAbi = [
  {
    type: "function",
    name: "wrap",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "to", type: "address" }
    ],
    outputs: [
      { name: "net", type: "uint256" },
      { name: "mintedShares", type: "uint256" }
    ]
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }]
  }
] as const;

const complianceAbi = [
  {
    type: "function",
    name: "getFlags",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [
      { name: "set", type: "bool" },
      { name: "enforceSanctions", type: "bool" },
      { name: "transferRestricted", type: "bool" },
      { name: "wrapToCustodyOnly", type: "bool" },
      { name: "unwrapFromCustodyOnly", type: "bool" },
      { name: "kycOnWrap", type: "bool" },
      { name: "kycOnUnwrap", type: "bool" }
    ]
  },
  { type: "function", name: "kyc", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "custody", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
  {
    type: "function",
    name: "setKyc",
    stateMutability: "nonpayable",
    inputs: [
      { name: "user", type: "address" },
      { name: "ok", type: "bool" }
    ],
    outputs: []
  },
  {
    type: "function",
    name: "setCustody",
    stateMutability: "nonpayable",
    inputs: [
      { name: "user", type: "address" },
      { name: "ok", type: "bool" }
    ],
    outputs: []
  }
] as const;

async function main() {
  const rpcUrl = env("RPC_URL") ?? env("SRC_RPC_URL");
  if (!rpcUrl) throw new Error("Missing RPC_URL (or SRC_RPC_URL)");

  const privateKey = env("PRIVATE_KEY") as `0x${string}` | undefined;
  if (!privateKey) throw new Error("Missing PRIVATE_KEY");

  const account = privateKeyToAccount(privateKey);

  const to = (getArg("--to") ?? env("TO") ?? account.address) as Address;
  if (!isAddress(to)) throw new Error("Invalid TO (or --to)");

  const publicClient = createPublicClient({ transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, transport: http(rpcUrl) });
  const chainId = await publicClient.getChainId();

  // Wrapper must be provided by the user (do not read from .env).
  // Supports either `--wrapper <NAME|ADDRESS>` or a positional arg: `<NAME|ADDRESS>`
  const wrapperInput = getArg("--wrapper") ?? getPositionalArg(0);
  const underlyingInput = getArg("--underlying") ?? env("UNDERLYING");
  const complianceInput = getArg("--compliance") ?? env("COMPLIANCE");

  const wrapper = resolveWrapper(wrapperInput, chainId);
  const underlying = requireAddress(underlyingInput, "UNDERLYING (or --underlying)");
  const compliance = resolveCompliance(complianceInput, chainId);

  const decimals = await publicClient.readContract({
    address: underlying,
    abi: erc20Abi,
    functionName: "decimals"
  });

  const amountWeiRaw = getArg("--amount-wei") ?? env("AMOUNT_WEI");
  const amountHuman = getArg("--amount") ?? env("AMOUNT");
  if (!amountWeiRaw && !amountHuman) {
    throw new Error('Missing amount: set AMOUNT_WEI / AMOUNT (or pass --amount-wei / --amount)');
  }
  const amountWei = amountWeiRaw ? BigInt(amountWeiRaw) : parseUnits(amountHuman!, decimals);

  // ==== compliance flags ====
  const flags = (await publicClient.readContract({
    address: compliance,
    abi: complianceAbi,
    functionName: "getFlags",
    args: [wrapper]
  })) as readonly [boolean, boolean, boolean, boolean, boolean, boolean, boolean];

  const wrapToCustodyOnly = flags[3];
  const kycOnWrap = flags[5];

  const summary = {
    rpcUrl,
    chainId,
    caller: account.address,
    to,
    wrapper,
    underlying,
    compliance,
    decimals,
    amountHuman: amountHuman ?? null,
    amountWei: amountWei.toString(),
    flags: {
      set: flags[0],
      enforceSanctions: flags[1],
      transferRestricted: flags[2],
      wrapToCustodyOnly: flags[3],
      unwrapFromCustodyOnly: flags[4],
      kycOnWrap: flags[5],
      kycOnUnwrap: flags[6]
    }
  };

  if (hasFlag("--dry-run")) {
    console.log(JSON.stringify(summary, null, 2));
    console.log("dry-run: not sending.");
    return;
  }

  await confirmOrExit(summary);

  // ===== Prepare compliance =====
  if (wrapToCustodyOnly) {
    const isCustody = await publicClient.readContract({
      address: compliance,
      abi: complianceAbi,
      functionName: "custody",
      args: [to]
    });
    if (!isCustody) {
      const tx = await walletClient.writeContract({
        address: compliance,
        abi: complianceAbi,
        functionName: "setCustody",
        args: [to, true],
        chain: undefined
      });
      console.log("setCustody tx =", tx);
      await publicClient.waitForTransactionReceipt({ hash: tx });
      console.log("setCustody confirmed");
    }
  }

  if (kycOnWrap) {
    const isKyc = await publicClient.readContract({
      address: compliance,
      abi: complianceAbi,
      functionName: "kyc",
      args: [account.address]
    });
    if (!isKyc) {
      const tx = await walletClient.writeContract({
        address: compliance,
        abi: complianceAbi,
        functionName: "setKyc",
        args: [account.address, true],
        chain: undefined
      });
      console.log("setKyc tx =", tx);
      await publicClient.waitForTransactionReceipt({ hash: tx });
      console.log("setKyc confirmed");
    }
  }

  // ===== Ensure allowance =====
  const bal = await publicClient.readContract({
    address: underlying,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account.address]
  });
  console.log("Caller underlying balance:", bal.toString());
  if (bal < amountWei) throw new Error("INSUFFICIENT_UNDERLYING_BALANCE");

  const curAllow = await publicClient.readContract({
    address: underlying,
    abi: erc20Abi,
    functionName: "allowance",
    args: [account.address, wrapper]
  });
  console.log("Current allowance:", curAllow.toString());

  if (curAllow < amountWei) {
    const approveHash = await walletClient.writeContract({
      address: underlying,
      abi: erc20Abi,
      functionName: "approve",
      args: [wrapper, MAX_UINT256],
      chain: undefined
    });
    console.log("approve tx =", approveHash);
    await publicClient.waitForTransactionReceipt({ hash: approveHash });
    console.log("approve confirmed");
  }

  // ===== Wrap =====
  const { request, result } = await publicClient.simulateContract({
    account: account.address,
    address: wrapper,
    abi: wrapperAbi,
    functionName: "wrap",
    args: [underlying, amountWei, to]
  });

  const [net, mintedShares] = result;

  const wrapHash = await walletClient.writeContract({
    ...request,
    chain: undefined
  });

  console.log("wrap tx =", wrapHash);
  await publicClient.waitForTransactionReceipt({ hash: wrapHash });

  const wrapperBal = await publicClient.readContract({
    address: wrapper,
    abi: wrapperAbi,
    functionName: "balanceOf",
    args: [to]
  });

  console.log("Underlying:", underlying);
  console.log("Wrapper   :", wrapper);
  console.log("To        :", to);
  console.log("Amount(wei):", amountWei.toString());
  console.log("Wrap -> net          :", net.toString());
  console.log("Wrap -> mintedShares :", mintedShares.toString());
  console.log("Wrapper balance(To)  :", wrapperBal.toString());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


