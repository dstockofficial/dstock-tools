function getFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

export async function run(args: string[]) {
  const name = getFlagValue(args, "--name") ?? "world";
  console.log(`Hello, ${name}!`);
}


