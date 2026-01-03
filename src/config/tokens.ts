import type { Address } from "viem";

/**
 * Token configuration for cross-chain operations between BSC and HyperCore.
 * 
 * To add a new token, copy the template below and fill in the addresses:
 * 
 * ```typescript
 * newtoken: {
 *   name: "NEWTOKENd",
 *   bsc: {
 *     wrapper: "0x...",      // DStockWrapper address on BSC
 *     adapter: "0x...",      // DStockOFTAdapter address on BSC
 *     underlying: "0x...",   // Original ERC20 token address on BSC
 *     router: "0x...",       // DStockRouter address on BSC (optional)
 *     unwrapComposer: "0x..." // DStockUnwrapComposer address on BSC (optional)
 *   },
 *   hyperEvm: {
 *     oft: "0x..."           // DStockOFT address on HyperEVM
 *   },
 *   hyperCore: {
 *     tokenIndex: 123        // Token index from HyperCore spotMeta API
 *   }
 * }
 * ```
 */
export type TokenConfig = {
  // Canonical name (used for display); matching is case-insensitive.
  name: string;

  // BSC chain configuration
  bsc: {
    wrapper: Address;          // DStockWrapper contract
    adapter: Address;          // DStockOFTAdapter (LayerZero bridge)
    underlying?: Address;      // Original ERC20 token (required for wrap/unwrap)
    router?: Address;          // DStockRouter (optional, one-click wrap + bridge)
    unwrapComposer?: Address;  // DStockUnwrapComposer (optional, HyperEVM -> Underlying)
  };

  // HyperEVM chain configuration
  hyperEvm: {
    oft: Address;              // DStockOFT contract
  };

  // HyperCore (L1) configuration
  hyperCore: {
    tokenIndex: number;        // Token index from spotMeta API
    depositAddress?: Address;  // Optional override for system/bridge address
  };
};

export const TOKENS: Record<string, TokenConfig> = {
  // ============================================================
  // CRCLd - Circle USD (deployed)
  // ============================================================
  crcld: {
    name: "CRCLd",
    bsc: {
      wrapper: "0x8edE6AffCBe962e642f83d84b8Af66313A700dDf",
      adapter: "0xF351FA44A73E6D1E9c4C2927A8D2b8c69a8B8897",
      underlying: "0x992879cd8ce0c312d98648875b5a8d6d042cbf34",
      router: "0x472bA703909F7dDa56d066957131D3F1ADDb4069"
    },
    hyperEvm: {
      oft: "0xe74aA6C4050A15790525eB11cc4562c664dC67C9"
    },
    hyperCore: {
      tokenIndex: 409
    }
  }

  // ============================================================
  // Add more tokens below (copy the template from above)
  // ============================================================
  // example: {
  //   name: "EXAMPLEd",
  //   bsc: {
  //     wrapper: "0x...",
  //     adapter: "0x...",
  //     underlying: "0x..."
  //   },
  //   hyperEvm: {
  //     oft: "0x..."
  //   },
  //   hyperCore: {
  //     tokenIndex: 999
  //   }
  // }
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


