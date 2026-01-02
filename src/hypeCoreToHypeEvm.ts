import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { isAddress, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { requireToken, type TokenConfig } from "./config/tokens.js";
import { toAssetBridgeAddress } from "./config/hypercore.js";

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
  if (hasFlag("--yes")) return;
  const rl = createInterface({ input, output });
  try {
    output.write(`\nAbout to execute HyperCore -> HyperEVM (spotSend):\n${JSON.stringify(summary, null, 2)}\n\n`);
    const ans = (await rl.question('Type "YES" to confirm: ')).trim();
    if (ans !== "YES") {
      console.log("Cancelled.");
      process.exit(1);
    }
  } finally {
    rl.close();
  }
}

// EIP-712 domain for HyperliquidSignTransaction
const HYPERLIQUID_DOMAIN = {
  name: "HyperliquidSignTransaction",
  version: "1",
  chainId: 42161, // Arbitrum chainId (standard for Hyperliquid signing)
  verifyingContract: "0x0000000000000000000000000000000000000000" as const
} as const;

// EIP-712 types for SpotSend
const SPOT_SEND_TYPES = {
  "HyperliquidTransaction:SpotSend": [
    { name: "hyperliquidChain", type: "string" },
    { name: "destination", type: "string" },
    { name: "token", type: "string" },
    { name: "amount", type: "string" },
    { name: "time", type: "uint64" }
  ]
} as const;

async function fetchSpotMeta(): Promise<any> {
  const res = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "spotMeta" })
  });
  if (!res.ok) throw new Error(`Failed to fetch spotMeta: ${res.status} ${res.statusText}`);
  return res.json();
}

async function fetchSpotBalance(user: string, tokenIndex: number): Promise<string | null> {
  const res = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "spotClearinghouseState", user })
  });
  if (!res.ok) throw new Error(`Failed to fetch spot balance: ${res.status} ${res.statusText}`);
  const data = (await res.json()) as any;
  const balances: any[] = data?.balances ?? [];
  const bal = balances.find((b) => Number(b?.token) === Number(tokenIndex));
  return bal?.total != null ? String(bal.total) : null;
}

function findTokenInSpotMeta(spotMeta: any, tokenIndex: number): { name: string; tokenId: string } | null {
  // spotMeta returns { tokens: [...], universe: [...] }
  // tokens contains the token metadata, universe contains trading pair info
  const tokens: any[] = spotMeta?.tokens ?? [];
  const token = tokens.find((t: any) => Number(t?.index) === tokenIndex);
  if (!token) return null;
  return {
    name: token.name,
    tokenId: token.tokenId
  };
}

async function signSpotSend(
  privateKey: `0x${string}`,
  message: {
    hyperliquidChain: string;
    destination: string;
    token: string;
    amount: string;
    time: bigint;
  }
): Promise<{ r: `0x${string}`; s: `0x${string}`; v: number }> {
  const account = privateKeyToAccount(privateKey);
  
  // Sign using EIP-712 typed data
  const signature = await account.signTypedData({
    domain: HYPERLIQUID_DOMAIN,
    types: SPOT_SEND_TYPES,
    primaryType: "HyperliquidTransaction:SpotSend",
    message
  });

  // Split signature into r, s, v
  const r = `0x${signature.slice(2, 66)}` as `0x${string}`;
  const s = `0x${signature.slice(66, 130)}` as `0x${string}`;
  const v = parseInt(signature.slice(130, 132), 16);

  return { r, s, v };
}

async function submitSpotSend(payload: {
  action: {
    type: "spotSend";
    hyperliquidChain: string;
    signatureChainId: string;
    destination: string;
    token: string;
    amount: string;
    time: number;
  };
  nonce: number;
  signature: { r: string; s: string; v: number };
}): Promise<any> {
  const res = await fetch("https://api.hyperliquid.xyz/exchange", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });

  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Failed to parse response: ${text}`);
  }

  if (data.status !== "ok") {
    throw new Error(`HyperCore API error: ${JSON.stringify(data)}`);
  }

  return data;
}

async function main() {
  const privateKey = env("PRIVATE_KEY") as `0x${string}` | undefined;
  if (!privateKey) throw new Error("Missing PRIVATE_KEY");

  const account = privateKeyToAccount(privateKey);

  // Token selection
  const tokenInput = getArg("--token") ?? getPositionalArg(0);
  const tokenConfig = requireToken(tokenInput);

  // Amount
  const amountHuman = getArg("--amount");
  if (!amountHuman) throw new Error("Missing --amount (human readable, e.g. 0.5)");

  // The system/bridge address for spotSend - tokens will be credited to the SENDER's HyperEVM address
  // Per Hyperliquid docs: "spotSend with the corresponding system address as the destination"
  // The tokens are credited by a system transaction where recipient is the sender of the spotSend action.
  const systemAddress = toAssetBridgeAddress(tokenConfig.hyperCore.tokenIndex);

  // Fetch spot meta to get tokenId
  const spotMeta = await fetchSpotMeta();
  const tokenInfo = findTokenInSpotMeta(spotMeta, tokenConfig.hyperCore.tokenIndex);
  if (!tokenInfo) {
    throw new Error(
      `Token ${tokenConfig.name} (index=${tokenConfig.hyperCore.tokenIndex}) not found in HyperCore spotMeta. ` +
        `This token may not be registered on HyperCore yet.`
    );
  }

  // Check current balance
  const currentBalance = await fetchSpotBalance(account.address, tokenConfig.hyperCore.tokenIndex);
  if (currentBalance === null) {
    throw new Error(`No balance found for ${tokenConfig.name} on HyperCore`);
  }

  const balanceNum = parseFloat(currentBalance);
  const amountNum = parseFloat(amountHuman);
  if (balanceNum < amountNum) {
    throw new Error(`Insufficient balance: have ${currentBalance}, want ${amountHuman}`);
  }

  // Prepare the token string format: "NAME:tokenId"
  const tokenStr = `${tokenInfo.name}:${tokenInfo.tokenId}`;

  const nonce = Date.now();

  const summary = {
    from: account.address,
    systemAddress,
    recipient: account.address,
    token: tokenConfig.name,
    tokenIndex: tokenConfig.hyperCore.tokenIndex,
    tokenStr,
    amountHuman,
    currentBalance,
    nonce,
    note: "spotSend to system address → tokens credited to sender's HyperEVM address"
  };

  if (hasFlag("--dry-run")) {
    console.log(JSON.stringify(summary, null, 2));
    console.log("dry-run: not sending.");
    return;
  }

  await confirmOrExit(summary);

  // Sign the action - destination is the system address, tokens will be credited to sender
  const signature = await signSpotSend(privateKey, {
    hyperliquidChain: "Mainnet",
    destination: systemAddress.toLowerCase(),
    token: tokenStr,
    amount: amountHuman,
    time: BigInt(nonce)
  });

  // Submit to HyperCore
  const payload = {
    action: {
      type: "spotSend" as const,
      hyperliquidChain: "Mainnet",
      signatureChainId: "0xa4b1", // Arbitrum chainId in hex
      destination: systemAddress.toLowerCase(),
      token: tokenStr,
      amount: amountHuman,
      time: nonce
    },
    nonce,
    signature
  };

  console.log("Submitting spotSend to HyperCore...");
  const result = await submitSpotSend(payload);
  console.log("Response:", JSON.stringify(result, null, 2));
  console.log(`\nSuccessfully initiated transfer of ${amountHuman} ${tokenConfig.name} from HyperCore to HyperEVM`);
  console.log(`Recipient on HyperEVM: ${account.address}`);
  console.log("\nNote: The transfer should appear on HyperEVM within a few seconds to minutes.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

