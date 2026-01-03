import type { Address, Hex } from "viem";

export type ComposeOptions = {
  receiveGas: number;
  receiveValue?: number;
  composeGas: number;
  composeValue?: number;
  composeIndex?: number;
};

export type FeeQuote = {
  nativeFee: bigint;
  lzTokenFee: bigint;
};

export type RouterParams = {
  token: string;
  amount: string;
  to?: Address;
};

export type RouterExecution = {
  success: boolean;
  txHash?: Hex;
  error?: string;
};
