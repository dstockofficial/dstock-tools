import type { ScriptModule } from "./types.js";

export const availableScripts = {
  hello: async () => (await import("./hello.js")) as ScriptModule,
  "print-env": async () => (await import("./print-env.js")) as ScriptModule
} as const;

export type ScriptName = keyof typeof availableScripts;

export async function runScriptByName(name: string, args: string[]) {
  const loader = (availableScripts as Record<string, () => Promise<ScriptModule>>)[name];
  if (!loader) throw new Error(`Unknown script: ${name}`);
  const mod = await loader();
  await mod.run(args);
}


