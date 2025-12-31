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
  type Chain
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc, mainnet } from "viem/chains";
import { resolveComplianceAddress } from "./config/chains.js";
import { requireToken } from "./config/tokens.js";

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
  if (input) {
    // Kept for backward compatibility; but env/config no longer expects COMPLIANCE.
    if (!isAddress(input)) throw new Error("Invalid COMPLIANCE (or --compliance)");
    return input;
  }
  return resolveComplianceAddress(chainId);
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
  const rpcUrl = env("SRC_RPC_URL");
  if (!rpcUrl) throw new Error("Missing SRC_RPC_URL");

  const privateKey = env("PRIVATE_KEY") as `0x${string}` | undefined;
  if (!privateKey) throw new Error("Missing PRIVATE_KEY");

  const account = privateKeyToAccount(privateKey);
  const prepareCompliance = hasFlag("--prepare-compliance");

  const to = (getArg("--to") ?? account.address) as Address;
  if (!isAddress(to)) throw new Error("Invalid TO (or --to)");

  const publicClient = createPublicClient({ transport: http(rpcUrl) });
  const chainId = await publicClient.getChainId();
  const chain: Chain | undefined = chainId === 56 ? bsc : chainId === 1 ? mainnet : undefined;
  if (!chain) throw new Error(`Unsupported chainId=${chainId}. Expected 56 (BSC) or 1 (Ethereum).`);
  const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });

  // Token selection (wrapper is derived from token on BSC).
  // Supports either `--token <NAME>` or a positional arg: `<NAME>`
  const tokenInput = getArg("--token") ?? getPositionalArg(0);
  const token = requireToken(tokenInput);

  const wrapper = token.bsc.wrapper;
  const compliance = resolveCompliance(undefined, chainId);

  // Underlying is token-specific. We keep an escape hatch for CLI override.
  const underlyingFromConfig = token.bsc.underlying;
  const underlyingInput = getArg("--underlying");
  const underlying = underlyingInput
    ? requireAddress(underlyingInput, "UNDERLYING (or --underlying)")
    : underlyingFromConfig;
  if (!underlying) {
    throw new Error(
      `Missing underlying for ${token.name}. Set it in src/config/tokens.ts (token.bsc.underlying) or pass --underlying <ERC20_ADDRESS>.`
    );
  }

  const decimals = await publicClient.readContract({
    address: underlying,
    abi: erc20Abi,
    functionName: "decimals"
  });

  const amountWeiRaw = getArg("--amount-wei");
  const amountHuman = getArg("--amount");
  if (!amountWeiRaw && !amountHuman) {
    throw new Error('Missing amount: pass --amount-wei / --amount');
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

  // Read current compliance states (only when the corresponding flag is enabled).
  const isCustody = wrapToCustodyOnly
    ? await publicClient.readContract({
        address: compliance,
        abi: complianceAbi,
        functionName: "custody",
        args: [to]
      })
    : null;

  const isKyc = kycOnWrap
    ? await publicClient.readContract({
        address: compliance,
        abi: complianceAbi,
        functionName: "kyc",
        args: [account.address]
      })
    : null;

  const needSetCustody = wrapToCustodyOnly && isCustody === false;
  const needSetKyc = kycOnWrap && isKyc === false;

  const summary = {
    rpcUrl,
    chainId,
    caller: account.address,
    to,
    wrapper,
    underlying,
    compliance,
    prepareCompliance,
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
    },
    complianceState: {
      isCustody,
      isKyc,
      needSetCustody,
      needSetKyc
    }
  };

  if (hasFlag("--dry-run")) {
    console.log(JSON.stringify(summary, null, 2));
    console.log("dry-run: not sending.");
    return;
  }

  await confirmOrExit(summary);

  // ===== Prepare compliance (admin-only on most deployments) =====
  // We do NOT attempt admin mutations unless explicitly asked.
  if ((needSetCustody || needSetKyc) && !prepareCompliance) {
    const missing: string[] = [];
    if (needSetCustody) missing.push("custody(TO) = true");
    if (needSetKyc) missing.push("kyc(CALLER) = true");
    console.error("");
    console.error("Compliance requirements are not satisfied:");
    for (const m of missing) console.error(`- ${m}`);
    console.error("");
    console.error(
      'If you have admin permissions on the Compliance contract, re-run with "--prepare-compliance".'
    );
    console.error("Otherwise, ask the Compliance admin to set these flags for you.");
    process.exit(1);
  }

  if (prepareCompliance) {
    if (needSetCustody) {
      try {
        const tx = await walletClient.writeContract({
          address: compliance,
          abi: complianceAbi,
          functionName: "setCustody",
          args: [to, true]
        });
        console.log("setCustody tx =", tx);
        await publicClient.waitForTransactionReceipt({ hash: tx });
        console.log("setCustody confirmed");
      } catch (err) {
        console.error("Failed to setCustody. You may not have permission on the Compliance contract.");
        throw err;
      }
    }

    if (needSetKyc) {
      try {
        const tx = await walletClient.writeContract({
          address: compliance,
          abi: complianceAbi,
          functionName: "setKyc",
          args: [account.address, true]
        });
        console.log("setKyc tx =", tx);
        await publicClient.waitForTransactionReceipt({ hash: tx });
        console.log("setKyc confirmed");
      } catch (err) {
        console.error("Failed to setKyc. You may not have permission on the Compliance contract.");
        throw err;
      }
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
      args: [wrapper, MAX_UINT256]
    });
    console.log("approve tx =", approveHash);
    await publicClient.waitForTransactionReceipt({ hash: approveHash });
    console.log("approve confirmed");
  }

  // ===== Wrap =====
  const { request, result } = await publicClient.simulateContract({
    // IMPORTANT: pass LocalAccount so viem signs locally and uses eth_sendRawTransaction.
    // If we pass an address string, viem will try eth_sendTransaction (not supported on many public RPCs).
    account,
    address: wrapper,
    abi: wrapperAbi,
    functionName: "wrap",
    args: [underlying, amountWei, to]
  });

  const [net, mintedShares] = result;

  const wrapHash = await walletClient.writeContract(request);

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


