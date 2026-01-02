import "dotenv/config";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createPublicClient, formatUnits, http, isAddress, parseUnits } from "viem";
import { bsc } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { requireToken } from "./config/tokens.js";

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

const erc20BalanceAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }]
  }
] as const;

const decimalsAbi = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] }
] as const;

async function main() {
  const token = getArg("--token") ?? getPositionalArg(0);
  if (!token) throw new Error("Missing token. Usage: npm run flowHypeCoreToBsc -- <TOKEN> --to <ADDR> --amount <AMOUNT>");

  const to = getArg("--to");
  if (!to || !isAddress(to)) throw new Error("Missing/invalid --to (recipient on BSC for final unwrapped tokens)");

  const amount = getArg("--amount");
  const spotSendAmount = getArg("--spot-send-amount") ?? amount;
  const bridgeAmount = getArg("--bridge-amount") ?? amount;
  const unwrapAmount = getArg("--unwrap-amount") ?? amount;

  if (!spotSendAmount) throw new Error("Missing --amount (or --spot-send-amount)");
  if (!bridgeAmount) throw new Error("Missing --amount (or --bridge-amount)");
  if (!unwrapAmount) throw new Error("Missing --amount (or --unwrap-amount)");

  // Pass-through flags (optional)
  const dryRun = hasFlag("--dry-run") ? ["--dry-run"] : [];
  const isDryRun = hasFlag("--dry-run");

  const srcRpcUrl = process.env.SRC_RPC_URL;
  if (!srcRpcUrl) throw new Error("Missing SRC_RPC_URL");
  const privateKey = process.env.PRIVATE_KEY as `0x${string}` | undefined;
  if (!privateKey) throw new Error("Missing PRIVATE_KEY");

  const account = privateKeyToAccount(privateKey);
  const tokenMeta = requireToken(token);

  // The flow assumes the BSC recipient is controlled by the same PRIVATE_KEY,
  // because the unwrap step uses the same wallet.
  if (to.toLowerCase() !== account.address.toLowerCase()) {
    throw new Error(
      `--to must equal the EVM address of PRIVATE_KEY for this flow.\n` +
        `to=${to}\n` +
        `signer=${account.address}\n` +
        `Otherwise step 3 (unwrap) cannot operate on the received tokens.`
    );
  }

  const hyperEvmRpcUrl = "https://rpc.hyperliquid.xyz/evm";
  const hyperEvmClient = createPublicClient({ transport: http(hyperEvmRpcUrl) });
  const bscClient = createPublicClient({ chain: bsc, transport: http(srcRpcUrl) });

  // Get token decimals
  const tokenDecimals = await hyperEvmClient.readContract({
    address: tokenMeta.hyperEvm.oft,
    abi: decimalsAbi,
    functionName: "decimals"
  });

  const tokenIndex = tokenMeta.hyperCore.tokenIndex;

  // ===== Step 1: HyperCore → HyperEVM (spotSend) =====
  console.log("\n========== Step 1: HyperCore → HyperEVM (spotSend) ==========\n");

  // Read HyperCore spot balance before
  const coreBalBeforeStr = await fetchHyperCoreSpotTotal(account.address, tokenIndex);
  const coreBalBefore = coreBalBeforeStr ? parseFloat(coreBalBeforeStr) : 0;
  console.log(`[flow] HyperCore spot balance before: ${coreBalBefore} ${tokenMeta.name}`);

  // Read HyperEVM balance before
  const hyperEvmBalBefore = await hyperEvmClient.readContract({
    address: tokenMeta.hyperEvm.oft,
    abi: erc20BalanceAbi,
    functionName: "balanceOf",
    args: [account.address]
  });
  console.log(`[flow] HyperEVM balance before: ${formatUnits(hyperEvmBalBefore, tokenDecimals)} ${tokenMeta.name}`);

  await runStep("hypeCoreToHypeEvm", "src/hypeCoreToHypeEvm.ts", [token, "--amount", spotSendAmount, ...dryRun]);

  if (!isDryRun) {
    const spotSendAmountWei = parseUnits(spotSendAmount, tokenDecimals);
    const expectedAtLeast = hyperEvmBalBefore + spotSendAmountWei;

    const started = Date.now();
    let lastPrintedAt = 0;
    let lastSeen = hyperEvmBalBefore;

    await pollUntil(
      "HyperEVM token balance credited from HyperCore",
      async () => {
        const bal = await hyperEvmClient.readContract({
          address: tokenMeta.hyperEvm.oft,
          abi: erc20BalanceAbi,
          functionName: "balanceOf",
          args: [account.address]
        });

        const now = Date.now();
        const shouldPrint = now - lastPrintedAt > 5_000 || bal !== lastSeen;
        if (shouldPrint && bal < expectedAtLeast) {
          lastPrintedAt = now;
          lastSeen = bal;
          const currentHuman = formatUnits(bal, tokenDecimals);
          const expectedHuman = formatUnits(expectedAtLeast, tokenDecimals);
          console.log(
            `[flow] Waiting for HyperEVM credit from HyperCore... elapsed=${formatElapsedMs(now - started)} ` +
              `current=${currentHuman} expected>=${expectedHuman} token=${tokenMeta.name}`
          );
        }
        return bal;
      },
      (bal) => bal >= expectedAtLeast,
      { timeoutMs: 5 * 60_000, intervalMs: 2_000 }
    );

    console.log(`[flow] HyperEVM balance credited!`);
  }

  // ===== Step 2: HyperEVM → BSC (LayerZero) =====
  console.log("\n========== Step 2: HyperEVM → BSC (LayerZero) ==========\n");

  // Read BSC wrapper balance before
  const bscWrapperBalBefore = await bscClient.readContract({
    address: tokenMeta.bsc.wrapper,
    abi: erc20BalanceAbi,
    functionName: "balanceOf",
    args: [account.address]
  });
  console.log(`[flow] BSC wrapper balance before: ${formatUnits(bscWrapperBalBefore, tokenDecimals)} ${tokenMeta.name}`);

  await runStep("hypeEvmToBsc", "src/hypeEvmToBsc.ts", [token, "--to", to, "--amount", bridgeAmount, ...dryRun]);

  if (!isDryRun) {
    const bridgeAmountWei = parseUnits(bridgeAmount, tokenDecimals);
    const expectedAtLeast = bscWrapperBalBefore + bridgeAmountWei;

    const started = Date.now();
    let lastPrintedAt = 0;
    let lastSeen = bscWrapperBalBefore;

    await pollUntil(
      "BSC wrapper balance credited from HyperEVM",
      async () => {
        const bal = await bscClient.readContract({
          address: tokenMeta.bsc.wrapper,
          abi: erc20BalanceAbi,
          functionName: "balanceOf",
          args: [account.address]
        });

        const now = Date.now();
        const shouldPrint = now - lastPrintedAt > 10_000 || bal !== lastSeen;
        if (shouldPrint && bal < expectedAtLeast) {
          lastPrintedAt = now;
          lastSeen = bal;
          const currentHuman = formatUnits(bal, tokenDecimals);
          const expectedHuman = formatUnits(expectedAtLeast, tokenDecimals);
          console.log(
            `[flow] Waiting for BSC credit from LayerZero... elapsed=${formatElapsedMs(now - started)} ` +
              `current=${currentHuman} expected>=${expectedHuman} token=${tokenMeta.name}`
          );
        }
        return bal;
      },
      (bal) => bal >= expectedAtLeast,
      // LayerZero cross-chain can take several minutes
      { timeoutMs: 30 * 60_000, intervalMs: 5_000 }
    );

    console.log(`[flow] BSC wrapper balance credited!`);
  }

  // ===== Step 3: Unwrap on BSC (CRCLd → CRCLon) =====
  console.log("\n========== Step 3: Unwrap on BSC (CRCLd → CRCLon) ==========\n");

  const underlying = tokenMeta.bsc.underlying;
  if (!underlying) {
    throw new Error(`Missing underlying address for ${tokenMeta.name}. Cannot proceed with unwrap.`);
  }

  // Read underlying balance before
  const underlyingBalBefore = await bscClient.readContract({
    address: underlying,
    abi: erc20BalanceAbi,
    functionName: "balanceOf",
    args: [account.address]
  });
  console.log(`[flow] BSC underlying balance before: ${formatUnits(underlyingBalBefore, tokenDecimals)}`);

  await runStep("bscUnwrap", "src/bscUnwrap.ts", [token, "--to", to, "--amount", unwrapAmount, ...dryRun]);

  if (!isDryRun) {
    // Final check - verify underlying balance increased
    const underlyingBalAfter = await bscClient.readContract({
      address: underlying,
      abi: erc20BalanceAbi,
      functionName: "balanceOf",
      args: [account.address]
    });

    const delta = underlyingBalAfter - underlyingBalBefore;
    console.log(`\n========== Flow Complete ==========`);
    console.log(`[flow] Final underlying balance: ${formatUnits(underlyingBalAfter, tokenDecimals)}`);
    console.log(`[flow] Received: ${formatUnits(delta, tokenDecimals)} underlying tokens`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

