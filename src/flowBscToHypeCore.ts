import "dotenv/config";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createPublicClient, formatUnits, http, isAddress, parseUnits } from "viem";
import { bsc } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { requireToken } from "./config/tokens.js";
import { toAssetBridgeAddress } from "./config/hypercore.js";

function getArg(name: string): string | undefined {
  const idx = process.argv.findIndex((a) => a === name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function hasFlag(flag: string) {
  return process.argv.includes(flag);
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

async function runStep(stepName: string, scriptRelPath: string, args: string[]) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const tsxBin =
    process.platform === "win32"
      ? path.join(repoRoot, "node_modules", ".bin", "tsx.cmd")
      : path.join(repoRoot, "node_modules", ".bin", "tsx");

  const scriptAbsPath = path.join(repoRoot, scriptRelPath);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(tsxBin, [scriptAbsPath, ...args], {
      stdio: "inherit",
      env: process.env
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) return reject(new Error(`${stepName} terminated by signal: ${signal}`));
      if (code === 0) return resolve();
      return reject(new Error(`${stepName} failed with exit code ${code}`));
    });
  });
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function pollUntil<T>(
  label: string,
  read: () => Promise<T>,
  ok: (value: T) => boolean,
  opts?: { timeoutMs?: number; intervalMs?: number }
): Promise<T> {
  const timeoutMs = opts?.timeoutMs ?? 10 * 60_000;
  const intervalMs = opts?.intervalMs ?? 5_000;
  const started = Date.now();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timeout waiting for: ${label}`);
    }
    await sleep(intervalMs);
  }
}

function formatElapsedMs(ms: number) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}m${r}s` : `${r}s`;
}

async function fetchHyperCoreSpotTotal(user: string, tokenIndex: number): Promise<string | null> {
  const res = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "spotClearinghouseState", user })
  });
  if (!res.ok) throw new Error(`HyperCore API error: ${res.status} ${res.statusText}`);
  const data = (await res.json()) as any;
  const balances: any[] = data?.balances ?? [];
  const bal = balances.find((b) => Number(b?.token) === Number(tokenIndex));
  return bal?.total != null ? String(bal.total) : null;
}

async function main() {
  const token = getArg("--token") ?? getPositionalArg(0);
  if (!token) throw new Error("Missing token. Usage: npm run flow -- <TOKEN> --to <ADDR> --amount <AMOUNT>");

  const to = getArg("--to");
  if (!to || !isAddress(to)) throw new Error("Missing/invalid --to (recipient on destination chain for sendToHyperEvm)");

  const amount = getArg("--amount");
  const wrapAmount = getArg("--wrap-amount") ?? amount;
  const sendAmount = getArg("--send-amount") ?? amount;
  const coreAmount = getArg("--core-amount") ?? amount;

  if (!wrapAmount) throw new Error("Missing --amount (or --wrap-amount)");
  if (!sendAmount) throw new Error("Missing --amount (or --send-amount)");
  if (!coreAmount) throw new Error("Missing --amount (or --core-amount)");

  // Pass-through flags (optional)
  const dryRun = hasFlag("--dry-run") ? ["--dry-run"] : [];
  const isDryRun = hasFlag("--dry-run");

  const srcRpcUrl = process.env.SRC_RPC_URL;
  if (!srcRpcUrl) throw new Error("Missing SRC_RPC_URL");
  const privateKey = process.env.PRIVATE_KEY as `0x${string}` | undefined;
  if (!privateKey) throw new Error("Missing PRIVATE_KEY");

  const account = privateKeyToAccount(privateKey);
  const tokenMeta = requireToken(token);

  // The flow assumes the HyperEVM recipient is controlled by the same PRIVATE_KEY,
  // because step 3 needs to transfer the token out from that address.
  if (to.toLowerCase() !== account.address.toLowerCase()) {
    throw new Error(
      `--to must equal the EVM address of PRIVATE_KEY for this flow.\n` +
        `to=${to}\n` +
        `signer=${account.address}\n` +
        `Otherwise step 3 cannot transfer the token to HyperCore.`
    );
  }

  // Step 1: wrap on BSC
  const bscClient = createPublicClient({ chain: bsc, transport: http(srcRpcUrl) });
  const wrapperBalBefore = await bscClient.readContract({
    address: tokenMeta.bsc.wrapper,
    abi: [
      {
        type: "function",
        name: "balanceOf",
        stateMutability: "view",
        inputs: [{ type: "address" }],
        outputs: [{ type: "uint256" }]
      }
    ] as const,
    functionName: "balanceOf",
    args: [account.address]
  });

  await runStep("bscWrap", "src/bscWrap.ts", [token, "--amount", wrapAmount, ...dryRun]);

  if (!isDryRun) {
    await pollUntil(
      "wrapper balance increase after wrap",
      async () =>
        await bscClient.readContract({
          address: tokenMeta.bsc.wrapper,
          abi: [
            {
              type: "function",
              name: "balanceOf",
              stateMutability: "view",
              inputs: [{ type: "address" }],
              outputs: [{ type: "uint256" }]
            }
          ] as const,
          functionName: "balanceOf",
          args: [account.address]
        }),
      (bal) => bal > wrapperBalBefore,
      { timeoutMs: 2 * 60_000, intervalMs: 3_000 }
    );
  }

  // Step 2: send to HyperEVM (LayerZero)
  const hyperEvmRpcUrl = "https://rpc.hyperliquid.xyz/evm";
  const hyperEvmClient = createPublicClient({ transport: http(hyperEvmRpcUrl) });
  const tokenDecimals = await hyperEvmClient.readContract({
    address: tokenMeta.hyperEvm.oft,
    abi: [{ type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] }] as const,
    functionName: "decimals"
  });
  const sendAmountWei = parseUnits(sendAmount, tokenDecimals);
  const hyperBalBefore = await hyperEvmClient.readContract({
    address: tokenMeta.hyperEvm.oft,
    abi: [
      {
        type: "function",
        name: "balanceOf",
        stateMutability: "view",
        inputs: [{ type: "address" }],
        outputs: [{ type: "uint256" }]
      }
    ] as const,
    functionName: "balanceOf",
    args: [to]
  });

  await runStep("bscToHypeEvm", "src/bscToHypeEvm.ts", [token, "--to", to, "--amount", sendAmount, ...dryRun]);

  if (!isDryRun) {
    // Fees are paid in native gas (HYPE/BNB), not in the bridged token amount.
    // So we wait for the full credited amount.
    const expectedAtLeast = hyperBalBefore + sendAmountWei;

    const started = Date.now();
    let lastPrintedAt = 0;
    let lastSeen = hyperBalBefore;

    await pollUntil(
      "HyperEVM token balance credited",
      async () => {
        const bal = await hyperEvmClient.readContract({
          address: tokenMeta.hyperEvm.oft,
          abi: [
            {
              type: "function",
              name: "balanceOf",
              stateMutability: "view",
              inputs: [{ type: "address" }],
              outputs: [{ type: "uint256" }]
            }
          ] as const,
          functionName: "balanceOf",
          args: [to]
        });

        const now = Date.now();
        const shouldPrint =
          now - lastPrintedAt > 5_000 || // print at most every 5s
          bal !== lastSeen; // or when balance changes
        if (shouldPrint && bal < expectedAtLeast) {
          lastPrintedAt = now;
          lastSeen = bal;
          const currentHuman = formatUnits(bal, tokenDecimals);
          const expectedHuman = formatUnits(expectedAtLeast, tokenDecimals);
          console.log(
            `[flow] Waiting for HyperEVM credit... elapsed=${formatElapsedMs(now - started)} ` +
              `current=${currentHuman} expected>=${expectedHuman} token=${tokenMeta.name}`
          );
        }
        return bal;
      },
      (bal) => bal >= expectedAtLeast,
      // poll every 1 second, and keep waiting "until it arrives"
      { timeoutMs: 24 * 60 * 60_000, intervalMs: 1_000 }
    );
  }

  // Step 3: send token from HyperEVM to HyperCore (tokenIndex-derived bridge address)
  const tokenIndex = tokenMeta.hyperCore.tokenIndex;
  const coreBridge = toAssetBridgeAddress(tokenIndex);
  const coreAmountWei = parseUnits(coreAmount, tokenDecimals);

  // Read HyperCore spot balance before (best-effort; if API returns null, treat as 0).
  const coreBalBeforeStr = await fetchHyperCoreSpotTotal(account.address, tokenIndex);
  const coreBalBefore = coreBalBeforeStr ? parseUnits(coreBalBeforeStr, tokenDecimals) : 0n;

  await runStep("hypeEvmToHypeCore", "src/hypeEvmToHypeCore.ts", [token, "--amount", coreAmount, ...dryRun]);

  if (!isDryRun) {
    const minExpected = (coreAmountWei * 999n) / 1000n;
    await pollUntil(
      `HyperCore spot credit for tokenIndex=${tokenIndex}`,
      async () => {
        const s = await fetchHyperCoreSpotTotal(account.address, tokenIndex);
        return s ? parseUnits(s, tokenDecimals) : 0n;
      },
      (bal) => bal >= coreBalBefore + minExpected,
      { timeoutMs: 10 * 60_000, intervalMs: 5_000 }
    );

    // Sanity note: the bridge address is deterministically derived; we don't need to check it, but it helps debugging.
    void coreBridge;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


