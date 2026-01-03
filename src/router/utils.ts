import { Options } from "@layerzerolabs/lz-v2-utilities";
import { encodeAbiParameters, isAddress, padHex, type Address, type Hex } from "viem";
import type { TokenConfig } from "../config/tokens.js";
import type { ComposeOptions } from "./types.js";

export const HYPEREVM_EID = 30367;
export const DEFAULT_LZ_RECEIVE_GAS = 200000;
export const DEFAULT_LZ_COMPOSE_GAS = 200000;

export function hasFlag(flag: string) {
  return process.argv.includes(flag);
}

export function getArg(name: string): string | undefined {
  const idx = process.argv.findIndex((a) => a === name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

export function getPositionalArg(index: number): string | undefined {
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

export function env(name: string): string | undefined {
  const v = process.env[name];
  return v != null && v !== "" ? v : undefined;
}

export function requireAddress(input: string | undefined, label: string): Address {
  if (!input) throw new Error(`Missing ${label}`);
  if (!isAddress(input)) throw new Error(`Invalid ${label}`);
  return input as Address;
}

export function addressToBytes32(address: Address): Hex {
  return padHex(address, { size: 32 });
}

export function buildLzReceiveOptions(gasLimit: number, value = 0): Hex {
  return Options.newOptions().addExecutorLzReceiveOption(gasLimit, value).toHex() as Hex;
}

export function buildLzComposeOptions(options: ComposeOptions): Hex {
  const receiveGas = options.receiveGas ?? DEFAULT_LZ_RECEIVE_GAS;
  const receiveValue = options.receiveValue ?? 0;
  const composeGas = options.composeGas ?? DEFAULT_LZ_COMPOSE_GAS;
  const composeValue = options.composeValue ?? 0;
  const composeIndex = options.composeIndex ?? 0;

  return Options.newOptions()
    .addExecutorLzReceiveOption(receiveGas, receiveValue)
    .addExecutorComposeOption(composeIndex, composeGas, composeValue)
    .toHex() as Hex;
}

export function buildComposeMsg(receiver?: Address): Hex {
  if (!receiver) throw new Error("Missing receiver for composeMsg");
  return encodeAbiParameters([{ type: "address" }], [receiver]);
}

export function resolveBscRpcUrl(): string {
  return env("SRC_RPC_URL") ?? env("BSC_RPC_URL") ?? "https://bsc-dataseed.binance.org";
}

export function resolveHyperEvmRpcUrl(): string {
  return env("HYPEREVM_RPC_URL") ?? env("HYPEEVM_RPC_URL") ?? "https://rpc.hyperliquid.xyz/evm";
}

export function resolvePrivateKey(): `0x${string}` {
  const pk = env("PRIVATE_KEY") as `0x${string}` | undefined;
  if (!pk) throw new Error("Missing PRIVATE_KEY");
  return pk;
}

export function resolveRouterAddress(token: TokenConfig, override?: string): Address {
  const fromEnv = env("DSTOCK_ROUTER_ADDRESS") ?? env("ROUTER_ADDRESS");
  const candidate = override ?? fromEnv ?? token.bsc.router;
  if (!candidate || !isAddress(candidate)) {
    throw new Error(
      "Missing/invalid DStockRouter address. Use --router, set DSTOCK_ROUTER_ADDRESS/ROUTER_ADDRESS, or configure token.bsc.router."
    );
  }
  return candidate as Address;
}

export function resolveUnwrapComposerAddress(token: TokenConfig, override?: string): Address {
  const fromEnv = env("DSTOCK_UNWRAP_COMPOSER_ADDRESS") ?? env("UNWRAP_COMPOSER_ADDRESS");
  const candidate = override ?? fromEnv ?? token.bsc.unwrapComposer;
  if (!candidate || !isAddress(candidate)) {
    throw new Error(
      "Missing/invalid DStockUnwrapComposer address. Use --unwrap-composer, set DSTOCK_UNWRAP_COMPOSER_ADDRESS, or configure token.bsc.unwrapComposer."
    );
  }
  return candidate as Address;
}
