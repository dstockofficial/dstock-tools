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

Run a script by name:

```bash
npm run run -- hello --name "Ada"
```

List available scripts:

```bash
npm run run -- --help
```

## Project structure

- `src/run.ts`: script entrypoint / router
- `src/scripts/*`: individual scripts (each exports a `run(args)` function)
- `dist/*`: compiled output (after `npm run build`)

## Adding a new script

1. Create a new file: `src/scripts/my-script.ts`
2. Export a `run(args: string[])` function
3. Register it in `src/run.ts`

## Commands

- `npm run run -- <script> [...args]`: run a script via TS runtime (`tsx`)
- `npm run typecheck`: typecheck only
- `npm run build`: compile to `dist/`
- `npm run clean`: delete `dist/`


