// Runs the Next.js dev server, the background worker, the mock CMS servers and the mock analytics APIs together.
import { spawn } from "node:child_process";

const procs = [
  ["web", "npx", ["next", "dev"]],
  ["worker", "npx", ["tsx", "--env-file=.env.local", "scripts/worker.ts"]],
  ["mock-wp", "npx", ["tsx", "--env-file=.env.local", "scripts/mock-wordpress.ts"]],
  ["mock-cms", "npx", ["tsx", "--env-file=.env.local", "scripts/mock-cms.ts"]],
  ["mock-analytics", "npx", ["tsx", "--env-file=.env.local", "scripts/mock-analytics.ts"]],
].map(([name, cmd, args]) => {
  const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  const tag = (d) => d.toString().split("\n").filter(Boolean).forEach((l) => console.log(`[${name}] ${l}`));
  p.stdout.on("data", tag);
  p.stderr.on("data", tag);
  p.on("exit", (code) => console.log(`[${name}] exited with ${code}`));
  return p;
});
const stop = () => { procs.forEach((p) => p.kill("SIGTERM")); setTimeout(() => process.exit(0), 1500); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
