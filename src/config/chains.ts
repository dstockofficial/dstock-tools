import type { Address } from "viem";

export const CHAINS = {
  bscMainnet: {
    chainId: 56,
    name: "BSC Mainnet",
    compliance: "0xA0f16686BaaBF2AA81A56404B61560be89EaD271" as Address,
    wrapperImpl: "0x244b44C096A1Cd5d4A0327681341B2aF808625Ce" as Address,
    factory: "0x4388bdb2288Df7B441bec57976574C6f869b09a4" as Address
  },
  ethereumMainnet: {
    chainId: 1,
    name: "Ethereum Mainnet",
    compliance: "0xA0f16686BaaBF2AA81A56404B61560be89EaD271" as Address,
    wrapperImpl: "0x244b44C096A1Cd5d4A0327681341B2aF808625Ce" as Address,
    factory: "0x4388bdb2288Df7B441bec57976574C6f869b09a4" as Address
  },
  hyperEvm: {
    // RPC is hardcoded in scripts unless overridden in code; chainId is included for reference.
    chainId: 999,
    name: "HyperEVM"
  }
} as const;

export function resolveComplianceAddress(chainId: number): Address {
  if (chainId === CHAINS.bscMainnet.chainId) return CHAINS.bscMainnet.compliance;
  if (chainId === CHAINS.ethereumMainnet.chainId) return CHAINS.ethereumMainnet.compliance;
  throw new Error(`No Compliance address configured for chainId=${chainId}`);
}


