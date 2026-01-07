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

function env(name: string): string | undefined {
  const v = process.env[name];
  return v != null && v !== "" ? v : undefined;
}

async function confirmOrExit(summary: unknown) {
  // Skip confirmation by default; only prompt if --confirm is passed (and --yes is not)
  if (!hasFlag("--confirm") || hasFlag("--yes")) return;
  const rl = createInterface({ input, output });
  try {
    output.write(`\nAbout to execute UNWRAP:\n${JSON.stringify(summary, null, 2)}\n\n`);
    const ans = (await rl.question('Type "YES" to confirm: ')).trim();
    if (ans !== "YES") {
      console.log("Cancelled.");
      process.exit(1);
    }
  } finally {
    rl.close();
  }
}

const erc20Abi = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }
] as const;

const wrapperAbi = [
  {
    type: "function",
    name: "unwrap",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "to", type: "address" }
    ],
    outputs: []
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }]
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }]
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

  // Recipient for unwrapped tokens (defaults to caller)
  const to = (getArg("--to") ?? account.address) as Address;
  if (!isAddress(to)) throw new Error("Invalid TO (or --to)");

  const publicClient = createPublicClient({ transport: http(rpcUrl) });
  const chainId = await publicClient.getChainId();
  const chain: Chain | undefined = chainId === 56 ? bsc : chainId === 1 ? mainnet : undefined;
  if (!chain) throw new Error(`Unsupported chainId=${chainId}. Expected 56 (BSC) or 1 (Ethereum).`);
  const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });

  // Token selection
  const tokenInput = getArg("--token") ?? getPositionalArg(0);
  const token = requireToken(tokenInput);

  const wrapper = token.bsc.wrapper;
  const underlying = token.bsc.underlying;
  if (!underlying) {
    throw new Error(`Missing underlying for ${token.name}. Set it in src/config/tokens.ts`);
  }

  const compliance = resolveComplianceAddress(chainId);

  // Get wrapper decimals (shares decimals)
  const wrapperDecimals = await publicClient.readContract({
    address: wrapper,
    abi: wrapperAbi,
    functionName: "decimals"
  });

  // Parse amount
  const amountWeiRaw = getArg("--amount-wei");
  const amountHuman = getArg("--amount");
  if (!amountWeiRaw && !amountHuman) {
    throw new Error("Missing amount: pass --amount-wei / --amount");
  }
  const sharesWei = amountWeiRaw ? BigInt(amountWeiRaw) : parseUnits(amountHuman!, wrapperDecimals);

  // Check wrapper (shares) balance
  const wrapperBalance = await publicClient.readContract({
    address: wrapper,
    abi: wrapperAbi,
    functionName: "balanceOf",
    args: [account.address]
  });

  if (wrapperBalance < sharesWei) {
    throw new Error(
      `Insufficient wrapper balance: have ${wrapperBalance.toString()} shares, want ${sharesWei.toString()} shares`
    );
  }

  // Read compliance flags
  const flags = (await publicClient.readContract({
    address: compliance,
    abi: complianceAbi,
    functionName: "getFlags",
    args: [wrapper]
  })) as readonly [boolean, boolean, boolean, boolean, boolean, boolean, boolean];

  const unwrapFromCustodyOnly = flags[4];
  const kycOnUnwrap = flags[6];

  // Check compliance requirements for unwrap
  const isCustody = unwrapFromCustodyOnly
    ? await publicClient.readContract({
        address: compliance,
        abi: complianceAbi,
        functionName: "custody",
        args: [account.address]
      })
    : null;

  const isKyc = kycOnUnwrap
    ? await publicClient.readContract({
        address: compliance,
        abi: complianceAbi,
        functionName: "kyc",
        args: [account.address]
      })
    : null;

  const needSetCustody = unwrapFromCustodyOnly && isCustody === false;
  const needSetKyc = kycOnUnwrap && isKyc === false;

  const summary = {
    rpcUrl,
    chainId,
    caller: account.address,
    to,
    wrapper,
    underlying,
    compliance,
    prepareCompliance,
    wrapperDecimals,
    amountHuman: amountHuman ?? null,
    sharesWei: sharesWei.toString(),
    wrapperBalance: wrapperBalance.toString(),
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

  // Handle compliance requirements
  if ((needSetCustody || needSetKyc) && !prepareCompliance) {
    const missing: string[] = [];
    if (needSetCustody) missing.push("custody(CALLER) = true");
    if (needSetKyc) missing.push("kyc(CALLER) = true");
    console.error("");
    console.error("Compliance requirements are not satisfied for UNWRAP:");
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
          args: [account.address, true]
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

  // Get underlying balance before unwrap
  const underlyingBalBefore = await publicClient.readContract({
    address: underlying,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [to]
  });

  // Execute unwrap - args: (token, amount, to)
  // Note: amount is in underlying token units, not shares
  const { request } = await publicClient.simulateContract({
    account,
    address: wrapper,
    abi: wrapperAbi,
    functionName: "unwrap",
    args: [underlying, sharesWei, to]
  });

  const unwrapHash = await walletClient.writeContract(request);

  console.log("unwrap tx =", unwrapHash);
  await publicClient.waitForTransactionReceipt({ hash: unwrapHash });

  // Get balances after unwrap
  const underlyingBalAfter = await publicClient.readContract({
    address: underlying,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [to]
  });

  const wrapperBalAfter = await publicClient.readContract({
    address: wrapper,
    abi: wrapperAbi,
    functionName: "balanceOf",
    args: [account.address]
  });

  const receivedTokens = underlyingBalAfter - underlyingBalBefore;

  console.log("");
  console.log("Wrapper   :", wrapper);
  console.log("Underlying:", underlying);
  console.log("To        :", to);
  console.log("Amount(wei):", sharesWei.toString());
  console.log("Underlying balance (to):");
  console.log("  Before :", underlyingBalBefore.toString());
  console.log("  After  :", underlyingBalAfter.toString());
  console.log("  Received:", receivedTokens.toString());
  console.log("Wrapper balance (caller):", wrapperBalAfter.toString());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

