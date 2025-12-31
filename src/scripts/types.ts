export type ScriptModule = {
  run: (args: string[]) => void | Promise<void>;
};


