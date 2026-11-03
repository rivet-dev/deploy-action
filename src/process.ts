import { spawn } from "node:child_process";

export type RunOptions = { cwd?: string; env?: NodeJS.ProcessEnv; quiet?: boolean; timeoutMs?: number };
export type Run = (program: string, args: string[], options?: RunOptions) => Promise<string>;

// Arguments are never interpreted by a shell. Credentials belong in env, not args.
export const run: Run = (program, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(program, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const timer = setTimeout(() => { child.kill("SIGTERM"); }, options.timeoutMs ?? 45 * 60_000);
  child.stdout.on("data", (data: Buffer) => {
    output += data.toString();
    if (!options.quiet) process.stdout.write(data);
  });
  child.stderr.on("data", (data: Buffer) => { if (!options.quiet) process.stderr.write(data); });
  child.once("error", (error) => { clearTimeout(timer); reject(error); });
  child.once("close", (code, signal) => {
    clearTimeout(timer);
    if (code === 0) resolve(output);
    else reject(new Error(`${program} failed (${signal || `exit ${code}`})`));
  });
});
