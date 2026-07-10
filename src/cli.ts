#!/usr/bin/env node
import { computeDigestFor, digestCommit } from "./digest";
import { getCommitInfo, listCommitInfos } from "./git";
import { renderContent } from "./content";
import { renderIdentity, renderIdentityFrom, renderIdentityTo } from "./identity-view";
import { cachedDigestForInfo, cachedDigestRecordForInfo, commitStoreView, renderCommitStoreView } from "./store";
import { verifyDigest } from "./verify";
import { type BlockCommitDigest, type VerifyResult } from "./types";
import { type CommitInfo } from "./git";

type Format = "json" | "jsonl";
type ViewType = "content" | "identity" | "identity-from" | "identity-to";
type CacheAction = "status" | "verify";

interface CacheVerifySummary {
  checked: number;
  ok: number;
  failed: number;
  missing: number;
  skipped: number;
}

interface CacheVerifyView {
  schema_version: "blockcommit.cache-verify.v1";
  range: string;
  summary: CacheVerifySummary;
  results: VerifyResult[];
}

interface CliOptions {
  command:
    | "digest"
    | "view"
    | "cache"
    | "help";
  commit: string;
  cwd?: string;
  format?: Format;
  range?: string;
  cache: boolean;
  cacheAction: CacheAction;
  view: ViewType;
}

async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  if (options.command === "help") {
    printHelp();
    return 0;
  }

  if (options.command === "cache") {
    return options.cacheAction === "verify" ? runCacheVerify(options) : runCache(options);
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
  const digest = digestForCommit(options);
  if (options.view === "content") {
    process.stdout.write(renderContent(digest));
    return 0;
  }
  if (options.view === "identity") {
    writeTextView(renderIdentity(digest), "no cross-path identity flows\n");
    return 0;
  }
  if (options.view === "identity-from") {
    writeTextView(renderIdentityFrom(digest, { pretty: true, includeRemainder: false }), "no cross-path identity sources\n");
    return 0;
  }
  if (options.view === "identity-to") {
    writeTextView(renderIdentityTo(digest, { pretty: true, includeRemainder: false }), "no cross-path identity destinations\n");
    return 0;
  }
  throw new Error(`unknown view: ${options.view satisfies never}`);
}

function writeTextView(value: string, emptyValue: string): void {
  process.stdout.write(value.length === 0 ? emptyValue : value);
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

function runCache(options: CliOptions): number {
  const view = commitStoreView(options.cwd ?? process.cwd(), options.range ?? "HEAD");
  if (options.format === "json") {
    process.stdout.write(JSON.stringify(view));
    process.stdout.write("\n");
    return 0;
  }

  process.stdout.write(renderCommitStoreView(view));
  return 0;
}

function runCacheVerify(options: CliOptions): number {
  const cwd = options.cwd ?? process.cwd();
  const range = options.range ?? "HEAD";
  const cacheView = commitStoreView(cwd, range);
  const infos = listCommitInfos(cwd, range);
  const results: VerifyResult[] = [];
  let missing = 0;
  const skipped = cacheView.summary.skipped;

  for (const info of infos) {
    const record = cachedDigestRecordForInfo(info);
    if (record === null) {
      missing += 1;
      continue;
    }
    const result = record.ok
      ? verifyCachedDigest(cwd, info, record)
      : invalidCachedDigest(info, record.error);
    results.push(result);
    if (options.format === "json") {
      continue;
    }
    if (result.ok) {
      process.stdout.write(`ok ${result.commit.slice(0, 12)} (${result.files.length} checks)\n`);
      continue;
    }
    for (const file of result.files) {
      if (!file.ok) {
        process.stdout.write(`FAIL ${result.commit.slice(0, 12)} ${file.path}: ${file.reason}\n`);
      }
    }
  }

  const failed = results.filter((result) => !result.ok).length;
  const summary: CacheVerifySummary = {
    checked: results.length,
    ok: results.length - failed,
    failed,
    missing,
    skipped
  };

  if (options.format === "json") {
    const view: CacheVerifyView = {
      schema_version: "blockcommit.cache-verify.v1",
      range,
      summary,
      results
    };
    process.stdout.write(JSON.stringify(view));
    process.stdout.write("\n");
    return failed === 0 ? 0 : 1;
  }

  process.stdout.write(
    `verified ${summary.ok}/${summary.checked} cached commits ` +
      `(${summary.missing} missing, ${summary.skipped} skipped)\n`
  );
  return failed === 0 ? 0 : 1;
}

function invalidCachedDigest(info: CommitInfo, reason: string): VerifyResult {
  return {
    commit: info.commit,
    ok: false,
    files: [{ path: "<cache>", ok: false, reason }]
  };
}

function verifyCachedDigest(
  cwd: string,
  info: CommitInfo,
  record: { digest: unknown }
): VerifyResult {
  const result = verifyDigest({ cwd, digest: record.digest });
  const files = [...result.files];

  const cachedCommit = typeof record.digest === "object" && record.digest !== null && "commit" in record.digest
    ? (record.digest as { commit?: unknown }).commit
    : undefined;
  if (cachedCommit !== info.commit) {
    files.unshift({
      path: "<cache>",
      ok: false,
      reason: `cached digest is stored under ${info.commit} but describes ${JSON.stringify(cachedCommit)}`
    });
  }

  return {
    commit: info.commit,
    ok: result.ok && files.every((file) => file.ok),
    files
  };
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

function parseArgs(argv: string[]): CliOptions {
  const args = [...argv];
  const first = args.shift();
  if (first === undefined || first === "help" || first === "--help" || first === "-h") {
    return { command: "help", commit: "HEAD", format: "json", cache: true, cacheAction: "status", view: "content" };
  }

  if (
    first !== "digest" &&
    first !== "view" &&
    first !== "cache"
  ) {
    throw new Error(`unknown command: ${first}`);
  }

  const options: CliOptions = {
    command: first,
    commit: "HEAD",
    cache: true,
    cacheAction: "status",
    view: "content"
  };
  if (options.command === "cache" && args[0] === "verify") {
    args.shift();
    options.cacheAction = "verify";
  }
  let sawCommit = false;

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--no-cache") {
      options.cache = false;
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
    if (arg === "--content") {
      options.view = "content";
      continue;
    }
    if (arg === "--identity") {
      options.view = "identity";
      continue;
    }
    if (arg === "--identity-from") {
      options.view = "identity-from";
      continue;
    }
    if (arg === "--identity-to") {
      options.view = "identity-to";
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
  if (options.command === "cache" && sawCommit) {
    throw new Error(`${options.command} does not take a commit; use --range to choose history`);
  }
  if (options.command === "view" && options.range !== undefined) {
    throw new Error("view does not support --range");
  }
  if (options.command === "view" && options.format !== undefined) {
    throw new Error(`view --view ${options.view} does not support --format`);
  }
  if (options.command !== "view" && options.view !== "content") {
    throw new Error(`${options.command} does not support --view`);
  }
  if (options.command === "digest" && options.format === "jsonl" && options.range === undefined) {
    throw new Error("digest --format jsonl requires --range");
  }
  if (options.command === "cache" && options.format === "jsonl") {
    throw new Error(`${options.command} does not support --format jsonl`);
  }
  if (!options.cache && !isCacheControlledCommand(options.command)) {
    throw new Error(`${options.command} does not support --no-cache`);
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
    value === "identity-to"
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
  blockcommit view [commit] --identity [--no-cache] [--cwd <path>]
  blockcommit view [commit] --identity-from [--no-cache] [--cwd <path>]
  blockcommit view [commit] --identity-to [--no-cache] [--cwd <path>]
  blockcommit cache [--range <rev-range>] [--format json] [--cwd <path>]
  blockcommit cache verify [--range <rev-range>] [--format json] [--cwd <path>]

Commands:
  digest    emit the canonical JSON line-move digest for a commit
  view      emit readable content/identity views
  cache     refresh and print cache state: digested, undigested, invalid,
            and skipped commits. Use cache verify to check cached digest
            records against their referenced commits.

Options:
  --cwd <path>
            override the current working repo. The path may be a worktree
            or its .git directory; blockcommit normalizes it through an
            internal .git/.bgit_cache pointer.
  --no-cache
            bypass the persistent store for digest/view commands. By
            default, computed digests are read from or written to
            .git/.bgit_cache/blockcommit.
  --view <type>
            choose a view: content, identity, identity-from, or identity-to.
            Defaults to content.
  --identity, --identity-from, --identity-to
            shortcuts for the matching --view values.

Formats:
  json        structured JSON output where supported
  jsonl       one JSON record per line for digest ranges
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
