import type { Address } from "viem";

/**
 * tokenIndex -> HyperCore system/asset-bridge address
 *
 * Rule (as provided):
 * - Address is 42 chars total (0x + 40 hex digits)
 * - It always starts with "0x2"
 * - The remaining hex digits are the tokenIndex in hex, left-padded with zeros.
 */
export function toAssetBridgeAddress(tokenIndex: number): Address {
  const addressLength = 42;
  const addressPrefix = "0x2";
  const indexAsHex = Number(tokenIndex).toString(16);
  const addressLengthWithoutPrefix = addressLength - addressPrefix.length;
  return `${addressPrefix}${indexAsHex.padStart(addressLengthWithoutPrefix, "0")}` as Address;
}


