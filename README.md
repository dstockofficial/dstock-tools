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

Run the LayerZero OFT send script:

```bash
npm run sendToHyperEvm -- --to 0x6dc731481648Cd108120151F6ca1CbeA8277cE36 --amount 0.5 --yes
```

## Project structure

- `src/sendToHyperEvm.ts`: LayerZero OFT cross-chain send script
- `dist/*`: compiled output (after `npm run build`)

## Commands

- `npm run sendToHyperEvm -- [...args]`: run the send script via TS runtime (`tsx`)
- `npm run typecheck`: typecheck only
- `npm run build`: compile to `dist/`
- `npm run clean`: delete `dist/`


