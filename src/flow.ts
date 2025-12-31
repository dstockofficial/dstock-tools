import "dotenv/config";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

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

async function main() {
  const token = getArg("--token") ?? getPositionalArg(0);
  if (!token) throw new Error("Missing token. Usage: npm run flow -- <TOKEN> --to <ADDR> --amount <AMOUNT>");

  const to = getArg("--to");
  if (!to) throw new Error("Missing --to (recipient on destination chain for sendToHyperEvm)");

  const amount = getArg("--amount");
  const wrapAmount = getArg("--wrap-amount") ?? amount;
  const sendAmount = getArg("--send-amount") ?? amount;
  const coreAmount = getArg("--core-amount") ?? amount;

  if (!wrapAmount) throw new Error("Missing --amount (or --wrap-amount)");
  if (!sendAmount) throw new Error("Missing --amount (or --send-amount)");
  if (!coreAmount) throw new Error("Missing --amount (or --core-amount)");

  // Pass-through flags (optional)
  const dryRun = hasFlag("--dry-run") ? ["--dry-run"] : [];

  // Step 1: wrap on BSC
  await runStep("wrap", "src/wrap.ts", [token, "--amount", wrapAmount, ...dryRun]);

  // Step 2: send to HyperEVM (LayerZero)
  await runStep("sendToHyperEvm", "src/sendToHyperEvm.ts", [token, "--to", to, "--amount", sendAmount, ...dryRun]);

  // Step 3: send token from HyperEVM to HyperCore (tokenIndex-derived bridge address)
  await runStep("sendToHyperCore", "src/sendToHyperCore.ts", [token, "--amount", coreAmount, ...dryRun]);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


