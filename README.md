# dstock-tools

A collection of commonly used dStock utilities.

---

## 1. Wrap & Bridge Tool

Cross-chain bridge tool supporting bidirectional operations between BSC and HyperCore.

**Requirements:**
- Node.js **20+**
- npm (or pnpm/yarn)

### Quick start

Install dependencies:

```bash
npm install
```

Configure environment:

```bash
cp env.example .env
```

The `.env` file should contain only:

- `SRC_RPC_URL` (BSC mainnet RPC)
- `PRIVATE_KEY` (0x-prefixed)

### Flow Overview

#### BSC → HyperCore (Full Flow)

```
CRCLon (BSC) → wrap → CRCLd (BSC) → LayerZero → CRCLd (HyperEVM) → transfer → HyperCore Spot
```

#### HyperCore → BSC (Full Flow)

```
HyperCore Spot → spotSend → CRCLd (HyperEVM) → LayerZero → CRCLd (BSC) → unwrap → CRCLon (BSC)
```

### Scripts

#### BSC → HyperCore Direction

##### 1) Wrap on BSC (CRCLon → CRCLd)

```bash
npm run bscWrap -- CRCLd --amount 0.5
```

By default, the script will **not** attempt admin-only compliance mutations. If compliance checks are required and not satisfied, it will stop and tell you what needs to be set.

##### 2) BSC → HyperEVM (LayerZero)

```bash
npm run bscToHypeEvm -- CRCLd --to 0xYourRecipientAddress --amount 0.5
```

##### 3) HyperEVM → HyperCore

```bash
npm run hypeEvmToHypeCore -- CRCLd --amount 0.5
```

Note: this step transfers the token on HyperEVM into HyperCore via the HyperCore **system/bridge address derived from tokenIndex** (e.g. CRCLd → tokenIndex 409).

##### Full Flow (BSC → HyperCore)

Run all 3 steps in one command (each step will ask for confirmation):

```bash
npm run flowBscToHypeCore -- CRCLd --to 0xYourRecipientAddress --amount 0.5
```

---

#### HyperCore → BSC Direction

##### 1) HyperCore → HyperEVM (spotSend)

```bash
npm run hypeCoreToHypeEvm -- CRCLd --amount 0.5
```

This uses Hyperliquid's `spotSend` API to transfer tokens from your HyperCore spot balance to your HyperEVM address (defaults to same address).

Options:
- `--to <address>`: Optional destination address on HyperEVM (defaults to caller's address)
- `--dry-run`: Show what would be sent without executing
- `--yes`: Skip confirmation prompt

##### 2) HyperEVM → BSC (LayerZero)

```bash
npm run hypeEvmToBsc -- CRCLd --to 0xYourBscAddress --amount 0.5
```

This uses LayerZero OFT to send tokens from HyperEVM to BSC.

Options:
- `--dry-run`: Show what would be sent without executing
- `--yes`: Skip confirmation prompt

##### 3) Unwrap on BSC (CRCLd → CRCLon)

```bash
npm run bscUnwrap -- CRCLd --amount 0.5
```

Options:
- `--to <address>`: Recipient for unwrapped tokens (defaults to caller)
- `--prepare-compliance`: Attempt to set compliance flags if you have admin permissions
- `--dry-run`: Show what would be sent without executing
- `--yes`: Skip confirmation prompt

##### Full Flow (HyperCore → BSC)

Run all 3 steps in one command (each step will ask for confirmation, and waits for cross-chain confirmations):

```bash
npm run flowHypeCoreToBsc -- CRCLd --to 0xYourBscAddress --amount 0.5
```

Options:
- `--spot-send-amount <amount>`: Override amount for step 1 (HyperCore → HyperEVM)
- `--bridge-amount <amount>`: Override amount for step 2 (HyperEVM → BSC)
- `--unwrap-amount <amount>`: Override amount for step 3 (Unwrap on BSC)
- `--dry-run`: Show what would be sent without executing
- `--yes`: Skip all confirmation prompts

Note: The `--to` address must be controlled by the same `PRIVATE_KEY` since all steps use the same wallet.

### Token Registry

This repo includes a small address book for convenience. For example, on BSC you can set:

- pass `CRCLd` (case-insensitive) as the wrapper name, instead of pasting the wrapper address
- `COMPLIANCE` is optional on chainId **56** (BSC) and **1** (Ethereum) and will default automatically

#### Adding New Tokens

To add support for a new token, edit `src/config/tokens.ts` and add a new entry:

```typescript
newtoken: {
  name: "NEWTOKENd",
  bsc: {
    wrapper: "0x...",      // DStockWrapper address on BSC
    adapter: "0x...",      // DStockOFTAdapter address on BSC  
    underlying: "0x..."    // Original ERC20 token address on BSC
  },
  hyperEvm: {
    oft: "0x..."           // DStockOFT address on HyperEVM
  },
  hyperCore: {
    tokenIndex: 123        // Token index from HyperCore spotMeta API
  }
}
```

**How to find the tokenIndex:**

```bash
curl -X POST https://api.hyperliquid.xyz/info \
  -H "Content-Type: application/json" \
  -d '{"type": "spotMeta"}' | jq '.tokens[] | select(.name == "YOURTOKEN")'
```

Once added, you can use the new token name in all commands:

```bash
npm run bscWrap -- NEWTOKEN --amount 1.0
npm run flowBscToHypeCore -- NEWTOKEN --to 0xYourAddress --amount 1.0
```

### Project structure

- `src/bscWrap.ts`: Wrap ERC20 into the wrapper token (with compliance preparation)
- `src/bscUnwrap.ts`: Unwrap wrapper token back to underlying ERC20
- `src/bscToHypeEvm.ts`: LayerZero OFT cross-chain send (BSC → HyperEVM)
- `src/hypeEvmToBsc.ts`: LayerZero OFT cross-chain send (HyperEVM → BSC)
- `src/hypeEvmToHypeCore.ts`: HyperEVM → HyperCore transfer (to bridge address)
- `src/hypeCoreToHypeEvm.ts`: HyperCore → HyperEVM transfer (via spotSend API)
- `src/flowBscToHypeCore.ts`: Combined flow for BSC → HyperCore
- `src/flowHypeCoreToBsc.ts`: Combined flow for HyperCore → BSC
- `src/config/*`: in-code chain/token registry (addresses hardcoded here)
- `dist/*`: compiled output (after `npm run build`)

### Commands

| Command | Description |
|---------|-------------|
| `npm run bscWrap -- [...args]` | Wrap CRCLon → CRCLd on BSC |
| `npm run bscUnwrap -- [...args]` | Unwrap CRCLd → CRCLon on BSC |
| `npm run bscToHypeEvm -- [...args]` | Send CRCLd from BSC to HyperEVM |
| `npm run hypeEvmToBsc -- [...args]` | Send CRCLd from HyperEVM to BSC |
| `npm run hypeEvmToHypeCore -- [...args]` | Transfer from HyperEVM to HyperCore |
| `npm run hypeCoreToHypeEvm -- [...args]` | Transfer from HyperCore to HyperEVM |
| `npm run flowBscToHypeCore -- [...args]` | Full flow: BSC → HyperCore |
| `npm run flowHypeCoreToBsc -- [...args]` | Full flow: HyperCore → BSC |
| `npm run typecheck` | Typecheck only |
| `npm run build` | Compile to `dist/` |
| `npm run clean` | Delete `dist/` |

