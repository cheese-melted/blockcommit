#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { digestCommit } from "./digest";
import { listCommits } from "./git";
import { renderOps } from "./ops";
import { verifyCommit, verifyDigest } from "./verify";
import { type BlockCommitDigest } from "./types";

type Format = "json" | "ops" | "blockpatch";

interface CliOptions {
  command: "digest" | "verify" | "help";
  commit: string;
  cwd?: string;
  format: Format;
  pretty: boolean;
  strict: boolean;
  range?: string;
}

async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  if (options.command === "help") {
    printHelp();
    return 0;
  }

  if (options.command === "verify") {
    return runVerify(options);
  }

  const digest = digestCommit({ cwd: options.cwd, commit: options.commit });
  if (options.format === "ops") {
    process.stdout.write(renderOps(digest));
    return 0;
  }
  if (options.format === "blockpatch") {
    const unsupportedBlocks = digest.blocks.filter((block) => block.blockpatch.status !== "rendered");
    if (options.strict && unsupportedBlocks.length > 0) {
      for (const block of unsupportedBlocks) {
        process.stderr.write(
          `unsupported ${block.id}: ${block.blockpatch.reason ?? "not representable as blockpatch"}\n`
        );
      }
      return 1;
    }
    const rendered = digest.blocks
      .filter((block) => block.blockpatch.status === "rendered" && block.blockpatch.patch !== undefined)
      .map((block) => block.blockpatch.patch)
      .join("\n");
    process.stdout.write(rendered);
    const unsupported = digest.summary.unsupported_blockpatches;
    if (unsupported > 0) {
      process.stderr.write(
        `warning: ${unsupported} of ${digest.summary.blocks} blocks are not representable as blockpatch and were omitted; use --format json for the full digest\n`
      );
    }
    return 0;
  }

  process.stdout.write(JSON.stringify(digest, null, options.pretty ? 2 : 0));
  process.stdout.write("\n");
  return 0;
}

function runVerify(options: CliOptions): number {
  if (options.range === undefined && digestPathExists(options.commit)) {
    return runVerifyDigest(options);
  }

  const commits = options.range === undefined
    ? [options.commit]
    : listCommits(options.cwd ?? process.cwd(), options.range);
  let failures = 0;

  for (const commit of commits) {
    const result = verifyCommit({ cwd: options.cwd, commit });
    if (result.ok) {
      process.stdout.write(`ok ${result.commit.slice(0, 12)} (${result.files.length} files)\n`);
      continue;
    }
    failures += 1;
    for (const file of result.files) {
      if (!file.ok) {
        process.stdout.write(`FAIL ${result.commit.slice(0, 12)} ${file.path}: ${file.reason}\n`);
      }
    }
  }

  if (commits.length > 1) {
    process.stdout.write(`verified ${commits.length - failures}/${commits.length} commits\n`);
  }
  return failures === 0 ? 0 : 1;
}

function runVerifyDigest(options: CliOptions): number {
  const path = resolve(process.cwd(), options.commit);
  const digest = JSON.parse(readFileSync(path, "utf8")) as BlockCommitDigest;
  const result = verifyDigest({ cwd: options.cwd, digest });
  if (result.ok) {
    process.stdout.write(`ok ${result.commit.slice(0, 12)} digest\n`);
    return 0;
  }

  for (const file of result.files) {
    if (!file.ok) {
      process.stdout.write(`FAIL ${file.path}: ${file.reason}\n`);
    }
  }
  return 1;
}

function digestPathExists(value: string): boolean {
  return existsSync(resolve(process.cwd(), value));
}

function parseArgs(argv: string[]): CliOptions {
  const args = [...argv];
  const first = args.shift();
  if (first === undefined || first === "help" || first === "--help" || first === "-h") {
    return { command: "help", commit: "HEAD", format: "json", pretty: false, strict: false };
  }

  if (first !== "digest" && first !== "verify") {
    throw new Error(`unknown command: ${first}`);
  }

  const options: CliOptions = {
    command: first,
    commit: "HEAD",
    format: "json",
    pretty: false,
    strict: false
  };
  let sawCommit = false;

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--pretty") {
      options.pretty = true;
      continue;
    }
    if (arg === "--strict") {
      options.strict = true;
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
    if (options.command === "verify" && arg === "--range") {
      options.range = requireValue(args, arg);
      continue;
    }
    if (options.command === "verify" && arg?.startsWith("--range=")) {
      options.range = arg.slice("--range=".length);
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

  if (options.range !== undefined && sawCommit) {
    throw new Error("verify takes either a commit or --range, not both");
  }
  if (options.strict && (options.command !== "digest" || options.format !== "blockpatch")) {
    throw new Error("--strict is only supported with digest --format blockpatch");
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
  if (value === "json" || value === "ops" || value === "blockpatch") {
    return value;
  }
  throw new Error(`unknown format: ${value}`);
}

function printHelp(): void {
  process.stdout.write(`blockcommit

Usage:
  blockcommit digest [commit] [--cwd <repo>] [--pretty]
  blockcommit digest [commit] --format ops
  blockcommit digest [commit] --format blockpatch [--strict]
  blockcommit verify [commit] [--cwd <repo>]
  blockcommit verify digest.json [--cwd <repo>]
  blockcommit verify --range <rev-range> [--cwd <repo>]

Commands:
  digest  emit the line-move digest for a commit
  verify  rebuild each changed file from parent + digest blocks and
          byte-compare against the commit; --range walks a rev-list
          (merges skipped) and verifies every commit in it. Passing
          a JSON file verifies that digest against its referenced commit.

Formats:
  json        full line-move digest (canonical)
  ops         compact movement view: one line per block plus derived
              identity events (renames, path reuse)
  blockpatch  rendered blockpatch documents for directly representable blocks
              (--strict exits nonzero unless every block is rendered)
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
