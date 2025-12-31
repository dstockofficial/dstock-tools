# dstock-tools

A small **TypeScript + Node.js** toolbox for running one-off scripts and automations.

## Requirements

- Node.js **20+**
- npm (or pnpm/yarn)

## Quick start

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

Run the LayerZero OFT send script:

```bash
npm run sendToHyperEvm -- CRCLd --to 0x6dc731481648Cd108120151F6ca1CbeA8277cE36 --amount 0.5 --yes
```

Transfer native HYPE from HyperEVM -> HyperCore (credits your HyperCore spot balance):

```bash
npm run sendToHyperCore -- --amount 1.0 --yes
```

Note: this is intended for **native HYPE only**.

Run the wrap script (ERC20 -> wrapper shares):

```bash
npm run wrap -- CRCLd --amount 0.5 --yes
```

By default, the script will **not** attempt admin-only compliance mutations. If compliance checks are required and not satisfied, it will stop and tell you what needs to be set.

If you do have admin permission on the Compliance contract, you can enable the automatic preparation step:

```bash
npm run wrap -- CRCLd --amount 0.5 --yes --prepare-compliance
```

This repo includes a small address book for convenience. For example, on BSC you can set:

- pass `CRCLd` (case-insensitive) as the wrapper name, instead of pasting the wrapper address
- `COMPLIANCE` is optional on chainId **56** (BSC) and **1** (Ethereum) and will default automatically

## Project structure

- `src/sendToHyperEvm.ts`: LayerZero OFT cross-chain send script
- `src/sendToHyperCore.ts`: HyperEVM -> HyperCore transfer (native HYPE only)
- `src/wrap.ts`: Wrap ERC20 into the wrapper token (with compliance preparation)
- `src/config/*`: in-code chain/token registry (addresses hardcoded here)
- `dist/*`: compiled output (after `npm run build`)

## Commands

- `npm run sendToHyperEvm -- [...args]`: run the send script via TS runtime (`tsx`)
- `npm run sendToHyperCore -- [...args]`: transfer native HYPE from HyperEVM to HyperCore
- `npm run wrap -- [...args]`: run the wrap script via TS runtime (`tsx`)
- `npm run typecheck`: typecheck only
- `npm run build`: compile to `dist/`
- `npm run clean`: delete `dist/`


