#!/usr/bin/env node
"use strict";

const { runCli, printHelp } = require("./cli");

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return;
  }
  if (argv.includes("--version") || argv.includes("-V")) {
    const pkg = require("../package.json");
    console.log(pkg.version);
    return;
  }

  try {
    await runCli(argv);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.error(`Error: ${message}`);
    process.exitCode = 1;
  }
}

main();
