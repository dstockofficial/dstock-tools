import { availableScripts, runScriptByName } from "./scripts/index.js";

function printHelp() {
  const names = Object.keys(availableScripts).sort();
  console.log("Usage:");
  console.log("  npm run run -- <script> [...args]");
  console.log("");
  console.log("Available scripts:");
  for (const name of names) console.log(`  - ${name}`);
  console.log("");
  console.log("Examples:");
  console.log('  npm run run -- hello --name "Ada"');
  console.log("  npm run run -- print-env");
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    printHelp();
    process.exitCode = 0;
    return;
  }

  const [scriptName, ...scriptArgs] = argv;
  if (!scriptName) {
    printHelp();
    process.exitCode = 1;
    return;
  }

  if (!(scriptName in availableScripts)) {
    console.error(`Unknown script: ${scriptName}`);
    console.error("");
    printHelp();
    process.exitCode = 1;
    return;
  }

  await runScriptByName(scriptName, scriptArgs);
}

await main();


