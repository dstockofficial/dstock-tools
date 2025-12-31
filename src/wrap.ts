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

  const wrapper = (getArg("--wrapper") ?? env("WRAPPER")) as Address | undefined;
  const underlying = (getArg("--underlying") ?? env("UNDERLYING")) as Address | undefined;
  const compliance = (getArg("--compliance") ?? env("COMPLIANCE")) as Address | undefined;

  if (!wrapper || !isAddress(wrapper)) throw new Error("Missing/invalid WRAPPER (or --wrapper)");
  if (!underlying || !isAddress(underlying)) throw new Error("Missing/invalid UNDERLYING (or --underlying)");
  if (!compliance || !isAddress(compliance)) throw new Error("Missing/invalid COMPLIANCE (or --compliance)");

  const account = privateKeyToAccount(privateKey);

  const to = (getArg("--to") ?? env("TO") ?? account.address) as Address;
  if (!isAddress(to)) throw new Error("Invalid TO (or --to)");

  const publicClient = createPublicClient({ transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, transport: http(rpcUrl) });
  const chainId = await publicClient.getChainId();

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


