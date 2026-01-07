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
 *     underlying: "0x..."    // Original ERC20 token address on BSC
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
      underlying: "0x992879cd8ce0c312d98648875b5a8d6d042cbf34"
    },
    hyperEvm: {
      oft: "0xe74aA6C4050A15790525eB11cc4562c664dC67C9"
    },
    hyperCore: {
      tokenIndex: 409
    }
  },
  slvd: {
    name: "SLVd",
    bsc: {
      wrapper: "0x208aAde4f7a3Bdccc00BA2DfF88d85d653B2eCB8",
      adapter: "0x468F21018Ca8732ADcf13f059a07bfc08DfC8b8A",
      underlying: "0x8b872732b07be325a8803cdb480d9d20b6f8d11b"
    },
    hyperEvm: {
      oft: "0x7EF4Eba0C0200957e357627CEd1884D6CB63E961"
    },
    hyperCore: {
      tokenIndex: 411
    }
  },
  googld: {
    name: "GOOGLd",
    bsc: {
      wrapper: "0xb0b2e01984feb6fca9b852d962e2693d32338838",
      adapter: "0xa878A68424b6DE0f81D810056666601f692fD364",
      underlying: "0x091fc7778e6932d4009b087b191d1ee3bac5729a"
    },
    hyperEvm: {
      oft: "0x35eEdA03E55FF217a013892E9e2E37E792B264EA"
    },
    hyperCore: {
      tokenIndex: 412
    }
  },
  aapld: {
    name: "AAPLd",
    bsc: {
      wrapper: "0xb7d13e5b35cd6dc53489ae74a6703c3e5bea6bf0",
      adapter: "0xeFA6eDbf293d04A11031103ab7AbECa89E11E486",
      underlying: "0x390a684ef9cade28a7ad0dfa61ab1eb3842618c4"
    },
    hyperEvm: {
      oft: "0x7374DC1894fBD1bc6C42f6Ebbc50b78C211A8606"
    },
    hyperCore: {
      tokenIndex: 413
    }
  },
  bnbd: {
    name: "BNBd",
    bsc: {
      wrapper: "0x354269100ea51d52c075d05bceec9629f37cf338",
      adapter: "0xbeF3fC0BDe1507ea9E54a515ADebE41757F6c36E",
      underlying: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c"
    },
    hyperEvm: {
      oft: "0xFD6F06D323f6CB08eE9eeB2d201e9EC0E9112c88"
    },
    hyperCore: {
      tokenIndex: 414
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


