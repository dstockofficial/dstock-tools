import type { Address } from "viem";

export type TokenConfig = {
  // Canonical name (used for display); matching is case-insensitive.
  name: string;

  // BSC
  bsc: {
    wrapper: Address;
    adapter: Address; // DStockOFTAdapter
    // Underlying ERC20 that gets wrapped (REQUIRED for wrap script to actually work).
    // NOTE: not provided in the message; set it once you confirm the real address.
    underlying?: Address;
  };

  // HyperEVM
  hyperEvm: {
    oft: Address; // DStockOFT
  };

  // HyperCore
  hyperCore: {
    tokenIndex: number;
  };
};

export const TOKENS: Record<string, TokenConfig> = {
  // CRCLd (current production)
  crcld: {
    name: "CRCLd",
    bsc: {
      wrapper: "0x8edE6AffCBe962e642f83d84b8Af66313A700dDf",
      adapter: "0xF351FA44A73E6D1E9c4C2927A8D2b8c69a8B8897",
      underlying: "0x992879cd8ce0c312d98648875b5a8d6d042cbf34"
    },
    hyperEvm: {
      oft: "0xe74aA6C4050A15790525eB11cc4562c664dC67C9"
    },
    hyperCore: {
      tokenIndex: 409
    }
  }
};

export function normalizeTokenName(s: string) {
  return s.trim().toLowerCase();
}

export function requireToken(input: string | undefined): TokenConfig {
  if (!input) throw new Error("Missing token name (e.g. CRCLd).");
  const key = normalizeTokenName(input);
  const token = TOKENS[key];
  if (!token) {
    const known = Object.keys(TOKENS).sort().join(", ");
    throw new Error(`Unknown token: ${input}. Known tokens: ${known}`);
  }
  return token;
}


