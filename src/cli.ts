#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { computeDigestFor, digestCommit } from "./digest";
import { getCommitInfo, listCommitInfos, tryResolveCommit } from "./git";
import { renderContent } from "./content";
import { couplingPayload } from "./coupling";
import { renderIdentity, renderIdentityFrom, renderIdentityTo } from "./identity-view";
import { cachedDigestForInfo, cacheCommitRange, commitStoreView, renderCommitCacheResult, renderCommitStoreView } from "./store";
import { verifyCommitFor, verifyDigest } from "./verify";
import { type BlockCommitDigest, type VerifyResult } from "./types";
import { type CommitInfo } from "./git";

type Format = "json" | "jsonl";
type ViewType = "content" | "identity" | "identity-from" | "identity-to" | "coupling";

interface CliOptions {
  command:
    | "digest"
    | "view"
    | "commits"
    | "verify"
    | "help";
  commit: string;
  cwd?: string;
  format?: Format;
  range?: string;
  cache: boolean;
  fillCache: boolean;
  view: ViewType;
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
  if (options.command === "commits") {
    return runCommits(options);
  }
  if (options.command === "view") {
    return runView(options);
  }
  if (options.command === "digest" && options.range !== undefined) {
    return runDigestRange(options);
  }

  const digest = digestForCommit(options);
  const format = options.format ?? "json";
  if (format === "jsonl") {
    process.stdout.write(JSON.stringify(digest));
    process.stdout.write("\n");
    return 0;
  }

  process.stdout.write(JSON.stringify(digest));
  process.stdout.write("\n");
  return 0;
}

function runView(options: CliOptions): number {
  if (options.view === "coupling") {
    return runCoupling(options);
  }
  const digest = digestForCommit(options);
  if (options.view === "content") {
    process.stdout.write(renderContent(digest));
    return 0;
  }
  if (options.view === "identity") {
    process.stdout.write(renderIdentity(digest));
    return 0;
  }
  if (options.view === "identity-from") {
    process.stdout.write(renderIdentityFrom(digest));
    return 0;
  }
  if (options.view === "identity-to") {
    process.stdout.write(renderIdentityTo(digest));
    return 0;
  }
  throw new Error(`unknown view: ${options.view satisfies never}`);
}

function digestForCommit(options: CliOptions): BlockCommitDigest {
  if (!options.cache) {
    return digestCommit({ cwd: options.cwd, commit: options.commit });
  }
  return cachedDigestForInfo(getCommitInfo(options.cwd ?? process.cwd(), options.commit));
}

function digestForInfo(info: CommitInfo, options: CliOptions): BlockCommitDigest {
  return options.cache ? cachedDigestForInfo(info) : computeDigestFor(info).digest;
}

function runCommits(options: CliOptions): number {
  if (options.fillCache) {
    return runCache(options);
  }
  const view = commitStoreView(options.cwd ?? process.cwd(), options.range ?? "HEAD");
  if (options.format === "json") {
    process.stdout.write(JSON.stringify(view));
    process.stdout.write("\n");
    return 0;
  }

  process.stdout.write(renderCommitStoreView(view));
  return 0;
}

function runCache(options: CliOptions): number {
  const result = cacheCommitRange(options.cwd ?? process.cwd(), options.range ?? "HEAD");
  if (options.format === "json") {
    process.stdout.write(JSON.stringify(result));
    process.stdout.write("\n");
    return 0;
  }

  process.stdout.write(renderCommitCacheResult(result));
  return 0;
}

function runCoupling(options: CliOptions): number {
  if (options.range !== undefined) {
    return runCouplingRange(options);
  }

  const digest = digestForCommit(options);
  process.stdout.write(JSON.stringify(couplingPayload(digest)));
  process.stdout.write("\n");
  return 0;
}

function runCouplingRange(options: CliOptions): number {
  const format = options.format ?? "jsonl";
  if (format !== "jsonl") {
    throw new Error("view --view coupling --range only supports --format jsonl");
  }
  for (const info of listCommitInfos(options.cwd ?? process.cwd(), options.range!)) {
    process.stdout.write(JSON.stringify(couplingPayload(digestForInfo(info, options))));
    process.stdout.write("\n");
  }
  return 0;
}

function runDigestRange(options: CliOptions): number {
  const format = options.format ?? "jsonl";
  if (format !== "jsonl") {
    throw new Error("digest --range only supports --format jsonl");
  }
  for (const info of listCommitInfos(options.cwd ?? process.cwd(), options.range!)) {
    process.stdout.write(JSON.stringify(digestForInfo(info, options)));
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
    process.stdout.write(JSON.stringify(results.length === 1 ? results[0] : results));
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
    process.stdout.write(JSON.stringify(result));
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
    return { command: "help", commit: "HEAD", format: "json", cache: true, fillCache: false, view: "content" };
  }

  if (
    first !== "digest" &&
    first !== "view" &&
    first !== "commits" &&
    first !== "verify"
  ) {
    throw new Error(`unknown command: ${first}`);
  }

  const options: CliOptions = {
    command: first,
    commit: "HEAD",
    cache: true,
    fillCache: false,
    view: "content"
  };
  let sawCommit = false;

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--no-cache") {
      options.cache = false;
      continue;
    }
    if (arg === "--cache") {
      options.fillCache = true;
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
    if (arg === "--view") {
      options.view = parseView(requireValue(args, arg));
      continue;
    }
    if (arg?.startsWith("--view=")) {
      options.view = parseView(arg.slice("--view=".length));
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
  if (options.command === "commits" && sawCommit) {
    throw new Error(`${options.command} does not take a commit; use --range to choose history`);
  }
  if (options.command === "view" && options.range !== undefined && options.view !== "coupling") {
    throw new Error("view --range is only supported with --view coupling");
  }
  if (options.command === "view" && options.view !== "coupling" && options.format !== undefined) {
    throw new Error(`view --view ${options.view} does not support --format`);
  }
  if (options.command !== "view" && options.view !== "content") {
    throw new Error(`${options.command} does not support --view`);
  }
  if (options.fillCache && options.command !== "commits") {
    throw new Error(`${options.command} does not support --cache`);
  }
  if (options.command === "digest" && options.format === "jsonl" && options.range === undefined) {
    throw new Error("digest --format jsonl requires --range");
  }
  if (
    options.command === "view" &&
    options.view === "coupling" &&
    options.format === "jsonl" &&
    options.range === undefined
  ) {
    throw new Error("view --view coupling --format jsonl requires --range");
  }
  if (options.command === "commits" && options.format === "jsonl") {
    throw new Error(`${options.command} does not support --format jsonl`);
  }
  if (!options.cache && !isCacheControlledCommand(options.command)) {
    throw new Error(`${options.command} does not support --no-cache`);
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

function isCacheControlledCommand(command: CliOptions["command"]): boolean {
  return command === "digest" ||
    command === "view";
}

function parseFormat(value: string): Format {
  if (value === "json" || value === "jsonl") {
    return value;
  }
  throw new Error(`unknown format: ${value}`);
}

function parseView(value: string): ViewType {
  if (
    value === "content" ||
    value === "identity" ||
    value === "identity-from" ||
    value === "identity-to" ||
    value === "coupling"
  ) {
    return value;
  }
  throw new Error(`unknown view: ${value}`);
}

function printHelp(): void {
  process.stdout.write(`blockcommit

Usage:
  blockcommit digest [commit] [--no-cache] [--cwd <path>]
  blockcommit digest --range <rev-range> --format jsonl [--no-cache] [--cwd <path>]
  blockcommit view [commit] [--view content] [--no-cache] [--cwd <path>]
  blockcommit view [commit] --view identity [--no-cache] [--cwd <path>]
  blockcommit view [commit] --view identity-from [--no-cache] [--cwd <path>]
  blockcommit view [commit] --view identity-to [--no-cache] [--cwd <path>]
  blockcommit view [commit] --view coupling [--no-cache] [--cwd <path>]
  blockcommit view --view coupling --range <rev-range> --format jsonl [--no-cache] [--cwd <path>]
  blockcommit commits [--range <rev-range>] [--format json] [--cwd <path>]
  blockcommit commits --cache [--range <rev-range>] [--format json] [--cwd <path>]
  blockcommit verify [commit] [--cwd <path>]
  blockcommit verify digest.json --cwd <path>
  blockcommit verify [commit|digest.json] --format json [--cwd <path>]
  blockcommit verify --range <rev-range> [--cwd <path>]

Commands:
  digest    emit the canonical JSON line-move digest for a commit
  view      emit readable content/identity views or coupling JSON
  commits   persist and print the commit graph view: digested,
            undigested, and skipped commits. Add --cache to digest
            undigested non-merge commits into the persistent store.
  verify    rebuild each changed file from parent + digest blocks and
            byte-compare against the commit; --range walks a rev-list
            (merges skipped) and verifies every commit in it. Passing
            a JSON file verifies that digest against its referenced commit
            and requires a repo path when not run from that repo.

Options:
  --cwd <path>
            override the current working repo. The path may be a worktree
            or its .git directory; blockcommit normalizes it through an
            internal .git/.bgit_cache pointer.
  --no-cache
            bypass the persistent store for digest/view commands. By
            default, computed commits are read from or written to
            .git/.bgit_cache/blockcommit.
  --view <type>
            choose a view: content, identity, identity-from, identity-to,
            or coupling. Defaults to content.
  --cache
            with commits, digest undigested non-merge commits in the
            selected range into the persistent store.

Formats:
  json        structured JSON output where supported
  jsonl       one JSON record per line for digest and coupling ranges
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
