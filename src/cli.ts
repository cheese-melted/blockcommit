#!/usr/bin/env node
import { digestCommit } from "./digest";

type Format = "json" | "blockpatch";

interface CliOptions {
  command: "digest" | "help";
  commit: string;
  cwd?: string;
  format: Format;
  pretty: boolean;
}

async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  if (options.command === "help") {
    printHelp();
    return 0;
  }

  const digest = digestCommit({ cwd: options.cwd, commit: options.commit });
  if (options.format === "blockpatch") {
    const rendered = digest.blocks
      .filter((block) => block.blockpatch.status === "rendered" && block.blockpatch.patch !== undefined)
      .map((block) => block.blockpatch.patch)
      .join("\n");
    process.stdout.write(rendered);
    return 0;
  }

  process.stdout.write(JSON.stringify(digest, null, options.pretty ? 2 : 0));
  process.stdout.write("\n");
  return 0;
}

function parseArgs(argv: string[]): CliOptions {
  const args = [...argv];
  const first = args.shift();
  if (first === undefined || first === "help" || first === "--help" || first === "-h") {
    return { command: "help", commit: "HEAD", format: "json", pretty: false };
  }

  if (first !== "digest") {
    throw new Error(`unknown command: ${first}`);
  }

  const options: CliOptions = {
    command: "digest",
    commit: "HEAD",
    format: "json",
    pretty: false
  };
  let sawCommit = false;

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--pretty") {
      options.pretty = true;
      continue;
    }
    if (arg === "--cwd" || arg === "-C") {
      options.cwd = requireValue(args, arg);
      continue;
    }
    if (arg?.startsWith("--cwd=")) {
      options.cwd = arg.slice("--cwd=".length);
      continue;
    }
    if (arg === "--format") {
      options.format = parseFormat(requireValue(args, arg));
      continue;
    }
    if (arg?.startsWith("--format=")) {
      options.format = parseFormat(arg.slice("--format=".length));
      continue;
    }
    if (arg?.startsWith("-")) {
      throw new Error(`unknown option: ${arg}`);
    }
    if (sawCommit) {
      throw new Error(`unexpected argument: ${arg}`);
    }
    options.commit = arg ?? "HEAD";
    sawCommit = true;
  }

  return options;
}

function requireValue(args: string[], flag: string): string {
  const value = args.shift();
  if (value === undefined || value.length === 0) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseFormat(value: string): Format {
  if (value === "json" || value === "blockpatch") {
    return value;
  }
  throw new Error(`unknown format: ${value}`);
}

function printHelp(): void {
  process.stdout.write(`blockcommit

Usage:
  blockcommit digest [commit] [--cwd <repo>] [--pretty]
  blockcommit digest [commit] --format blockpatch

Formats:
  json        full line-move digest
  blockpatch  rendered blockpatch documents for directly representable blocks
`);
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
);
