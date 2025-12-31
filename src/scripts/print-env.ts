export async function run(args: string[]) {
  const key = args[0];
  if (!key) {
    console.log("Usage:");
    console.log("  npm run run -- print-env <ENV_KEY>");
    console.log("");
    console.log("Example:");
    console.log("  npm run run -- print-env HOME");
    process.exitCode = 1;
    return;
  }

  const value = process.env[key];
  if (value == null) {
    console.error(`Environment variable not found: ${key}`);
    process.exitCode = 2;
    return;
  }

  console.log(value);
}


