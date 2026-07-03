declare module "tachyon-dom/cli" {
  export const runCli: (argv?: readonly string[], entrypoint?: string) => Promise<number>;
}
