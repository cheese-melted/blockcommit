#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { computeDigest, computeDigestFor, digestCommit } from "./digest";
import { getCommitInfo, listCommitInfos, tryResolveCommit } from "./git";
import { renderIdentity, renderOps } from "./ops";
import { verifyCommitFor, verifyDigest } from "./verify";
import { type BlockCommitDigest, type VerifyResult } from "./types";

type Format = "json" | "jsonl" | "blockpatch";

interface CliOptions {
  command: "digest" | "content" | "identity" | "verify" | "help";
  commit: string;
  cwd?: string;
  format?: Format;
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
  if (options.command === "content") {
    const digest = digestCommit({ cwd: options.cwd, commit: options.commit });
    process.stdout.write(renderOps(digest));
    return 0;
  }
  if (options.command === "identity") {
    const digest = digestCommit({ cwd: options.cwd, commit: options.commit });
    process.stdout.write(renderIdentity(digest));
    return 0;
  }

  if (options.command === "digest" && options.range !== undefined) {
    return runDigestRange(options);
  }

  const format = options.format ?? "json";
  if (format === "blockpatch") {
    return runDigestBlockpatch(options);
  }

  const digest = digestCommit({ cwd: options.cwd, commit: options.commit });
  if (format === "jsonl") {
    process.stdout.write(JSON.stringify(digest));
    process.stdout.write("\n");
    return 0;
  }

  process.stdout.write(JSON.stringify(digest, null, options.pretty ? 2 : 0));
  process.stdout.write("\n");
  return 0;
}

function runDigestBlockpatch(options: CliOptions): number {
  const { digest, blockpatches } = computeDigest({ cwd: options.cwd, commit: options.commit });
  const unsupportedBlocks = blockpatches.filter((blockpatch) => blockpatch.status !== "rendered");
  if (options.strict && unsupportedBlocks.length > 0) {
    for (const blockpatch of unsupportedBlocks) {
      process.stderr.write(
        `unsupported ${blockpatch.id}: ${blockpatch.reason ?? "not representable as blockpatch"}\n`
      );
    }
    return 1;
  }
  const rendered = blockpatches
    .filter((blockpatch) => blockpatch.status === "rendered" && blockpatch.patch !== undefined)
    .map((blockpatch) => blockpatch.patch)
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

function runDigestRange(options: CliOptions): number {
  const format = options.format ?? "jsonl";
  if (format !== "jsonl") {
    throw new Error("digest --range only supports --format jsonl");
  }
  for (const info of listCommitInfos(options.cwd ?? process.cwd(), options.range!)) {
    process.stdout.write(JSON.stringify(computeDigestFor(info).digest));
    process.stdout.write("\n");
  }
  return 0;
}

function runVerify(options: CliOptions): number {
  // A name can be both a file and a ref; the ref wins so `verify main` never
  // silently reads a stray file named main.
  if (
    options.range === undefined &&
    digestPathExists(options.commit) &&
    tryResolveCommit(options.cwd ?? process.cwd(), options.commit) === null
  ) {
    return runVerifyDigest(options);
  }

  const cwd = options.cwd ?? process.cwd();
  const infos = options.range === undefined
    ? [getCommitInfo(cwd, options.commit)]
    : listCommitInfos(cwd, options.range);
  const results: VerifyResult[] = [];

  for (const info of infos) {
    const result = verifyCommitFor(info);
    results.push(result);
    if (options.format === "json") {
      continue;
    }
    if (result.ok) {
      process.stdout.write(`ok ${result.commit.slice(0, 12)} (${result.files.length} files)\n`);
      continue;
    }
    for (const file of result.files) {
      if (!file.ok) {
        process.stdout.write(`FAIL ${result.commit.slice(0, 12)} ${file.path}: ${file.reason}\n`);
      }
    }
  }

  const failures = results.filter((result) => !result.ok).length;
  if (options.format === "json") {
    process.stdout.write(JSON.stringify(results.length === 1 ? results[0] : results, null, options.pretty ? 2 : 0));
    process.stdout.write("\n");
  } else if (infos.length > 1) {
    process.stdout.write(`verified ${infos.length - failures}/${infos.length} commits\n`);
  }
  return failures === 0 ? 0 : 1;
}

function runVerifyDigest(options: CliOptions): number {
  const path = resolve(process.cwd(), options.commit);
  const digest = JSON.parse(readFileSync(path, "utf8")) as BlockCommitDigest;
  const result: VerifyResult = options.cwd === undefined
    ? {
      commit: digest.commit,
      ok: false,
      files: [{ path: "<digest>", ok: false, reason: "cwd is required to verify a saved digest" }]
    }
    : verifyDigest({ cwd: options.cwd, digest });
  if (options.format === "json") {
    process.stdout.write(JSON.stringify(result, null, options.pretty ? 2 : 0));
    process.stdout.write("\n");
    return result.ok ? 0 : 1;
  }
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

  if (first !== "digest" && first !== "content" && first !== "identity" && first !== "verify") {
    throw new Error(`unknown command: ${first}`);
  }

  const options: CliOptions = {
    command: first,
    commit: "HEAD",
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
    if (arg === "--range") {
      options.range = requireValue(args, arg);
      continue;
    }
    if (arg?.startsWith("--range=")) {
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
    throw new Error(`${options.command} takes either a commit or --range, not both`);
  }
  if ((options.command === "content" || options.command === "identity") && options.range !== undefined) {
    throw new Error(`${options.command} does not support --range`);
  }
  if ((options.command === "content" || options.command === "identity") && options.format !== undefined) {
    throw new Error(`${options.command} does not support --format`);
  }
  if (options.strict && (options.command !== "digest" || options.format !== "blockpatch")) {
    throw new Error("--strict is only supported with digest --format blockpatch");
  }
  if (options.command === "verify" && options.format !== undefined && options.format !== "json") {
    throw new Error("verify only supports --format json");
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
  if (value === "json" || value === "jsonl" || value === "blockpatch") {
    return value;
  }
  throw new Error(`unknown format: ${value}`);
}

function printHelp(): void {
  process.stdout.write(`blockcommit

Usage:
  blockcommit digest [commit] [--cwd <repo>] [--pretty]
  blockcommit content [commit] [--cwd <repo>]
  blockcommit identity [commit] [--cwd <repo>]
  blockcommit digest [commit] --format blockpatch [--strict]
  blockcommit digest --range <rev-range> --format jsonl [--cwd <repo>]
  blockcommit verify [commit] [--cwd <repo>]
  blockcommit verify digest.json --cwd <repo>
  blockcommit verify [commit|digest.json] --format json [--cwd <repo>]
  blockcommit verify --range <rev-range> [--cwd <repo>]

Commands:
  digest    emit the canonical JSON line-move digest for a commit
  content   emit compact content operations: moved, inserted, and deleted blocks
  identity  emit pairwise file-identity flow between paths
  verify    rebuild each changed file from parent + digest blocks and
            byte-compare against the commit; --range walks a rev-list
            (merges skipped) and verifies every commit in it. Passing
            a JSON file verifies that digest against its referenced commit
            and requires --cwd because digests do not store local repo paths.

Formats:
  json        full line-move digest (canonical)
  jsonl       one canonical digest JSON record per line, for digest ranges
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
