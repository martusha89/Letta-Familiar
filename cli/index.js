#!/usr/bin/env node

import { bold, dim, cyan, magenta } from "./lib/ui.js";

const [, , command, ...args] = process.argv;

const COMMANDS = {
  deploy: () => import("./commands/deploy.js"),
  status: () => import("./commands/status.js"),
};

async function main() {
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    process.exit(0);
  }

  if (command === "--version" || command === "-v") {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { getPackageRoot } = await import("./lib/platform.js");
    try {
      const pkg = JSON.parse(readFileSync(join(getPackageRoot(), "package.json"), "utf-8"));
      console.log(pkg.version);
    } catch {
      console.log("unknown");
    }
    process.exit(0);
  }

  const loader = COMMANDS[command];
  if (!loader) {
    console.error(`Unknown command: ${command}\n`);
    printHelp();
    process.exit(1);
  }

  const mod = await loader();
  await mod.default(args);
}

function printHelp() {
  console.log(`
${cyan(bold("FAMILIAR"))} ${dim("— A chat client for your Letta agent")}

${bold("Usage:")} familiar <command>

${bold("Commands:")}
  ${magenta("deploy")}    Deploy your personal Familiar to Cloudflare (one-time setup)
  ${magenta("status")}    Show your deployment URLs and config

${bold("Prerequisites:")}
  Node.js 18+, a free Cloudflare account, a Letta API key (https://app.letta.com/api-keys)

${bold("Quick start:")}
  ${dim("$")} npx familiar-letta deploy
`);
}

main();
