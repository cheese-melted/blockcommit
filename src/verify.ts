import { createHash } from "node:crypto";
import { computeDigest, computeDigestFor, type DigestComputation, type DigestOptions, type FileState } from "./digest";
import { type CommitInfo } from "./git";
import { countLineBytes, type LineRecord } from "./lines";
import { validateDigest } from "./validate";
import {
  type BlockCommitDigest,
  type ChangedFileDigest,
  type FileVerification,
  type LineMoveBlock,
  type VerifyResult
} from "./types";

export interface VerifyDigestOptions {
  cwd?: string;
  digest: unknown;
}

// Rebuilds every changed file from its parent-commit content plus the digest
// blocks and byte-compares the result against the actual committed content.
// A digest that survives this proves the blocks fully and consistently
// describe the commit.
export function verifyCommit(options: DigestOptions = {}): VerifyResult {
  return verifyComputation(computeDigest(options));
}

export function verifyCommitFor(info: CommitInfo): VerifyResult {
  return verifyComputation(computeDigestFor(info));
}

function verifyComputation({ digest, fileStates }: DigestComputation): VerifyResult {
  const files: FileVerification[] = [];

  for (const file of digest.files) {
    const state = fileStates.get(file.path);
    if (state === undefined) {
      files.push({ path: file.path, ok: false, reason: "digest lists a file with no recorded content" });
      continue;
    }
    if (file.line_digest_status === "unsupported") {
      files.push({
        path: file.path,
        ok: file.unsupported_reason !== undefined,
        reason: file.unsupported_reason === undefined ? "unsupported file has no unsupported_reason" : undefined
      });
      continue;
    }
    files.push(verifyFile(file.path, state, digest.blocks));
  }

  return {
    commit: digest.commit,
    ok: files.every((file) => file.ok),
    files
  };
}

export function verifyDigest(options: VerifyDigestOptions): VerifyResult {
  const validation = validateDigest(options.digest);
  if (!validation.ok) {
    return {
      commit: commitFromUnknownDigest(options.digest),
      ok: false,
      files: validation.errors.map((error) => ({
        path: error.path === "/" ? "<digest>" : `<digest>${error.path}`,
        ok: false,
        reason: `schema validation failed: ${error.message}`
      }))
    };
  }

  const supplied = options.digest as BlockCommitDigest;
  const checks: FileVerification[] = [];

  for (const block of supplied.blocks ?? []) {
    checks.push(verifyPayloadMetadata(block));
  }

  if (options.cwd === undefined) {
    checks.push({
      path: "<digest>",
      ok: false,
      reason: "cwd is required to verify a saved digest"
    });
    return {
      commit: supplied.commit,
      ok: false,
      files: checks
    };
  }

  const cwd = options.cwd;
  const recomputed = computeDigest({ cwd, commit: supplied.commit }).digest;
  checks.push(...compareDigestFacts(supplied, recomputed));

  return {
    commit: supplied.commit,
    ok: checks.every((file) => file.ok),
    files: checks
  };
}

function commitFromUnknownDigest(value: unknown): string {
  if (typeof value !== "object" || value === null || !("commit" in value)) {
    return "<unknown>";
  }
  const commit = (value as { commit?: unknown }).commit;
  return typeof commit === "string" ? commit : "<unknown>";
}

function verifyPayloadMetadata(block: LineMoveBlock): FileVerification {
  try {
    const payload = decodePayload(block);
    const payloadSha = sha256(payload);
    if (payloadSha !== block.payload_sha256) {
      return {
        path: `block:${block.id}`,
        ok: false,
        reason: `payload_sha256 is ${block.payload_sha256}, recomputed ${payloadSha}`
      };
    }
    if (payload.length !== block.payload_bytes) {
      return {
        path: `block:${block.id}`,
        ok: false,
        reason: `payload_bytes is ${block.payload_bytes}, recomputed ${payload.length}`
      };
    }
    const lineCount = countLineBytes(payload);
    if (lineCount !== block.payload_lines) {
      return {
        path: `block:${block.id}`,
        ok: false,
        reason: `payload_lines is ${block.payload_lines}, recomputed ${lineCount}`
      };
    }
    return { path: `block:${block.id}`, ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { path: `block:${block.id}`, ok: false, reason: message };
  }
}

function compareDigestFacts(supplied: BlockCommitDigest, recomputed: BlockCommitDigest): FileVerification[] {
  const checks: FileVerification[] = [];
  checks.push(compareValue("<digest>", "commit", supplied.commit, recomputed.commit));
  checks.push(compareValue("<digest>", "parent", supplied.parent, recomputed.parent));
  checks.push(compareValue("<digest>", "algorithm", supplied.algorithm, recomputed.algorithm));
  checks.push(compareValue("<digest>", "symbols", supplied.symbols, recomputed.symbols));
  checks.push(compareValue("<digest>", "summary", supplied.summary, recomputed.summary));
  checks.push(compareValue("<digest>", "identity", supplied.identity, recomputed.identity));
  checks.push(...compareFiles(supplied.files, recomputed.files));
  checks.push(...compareBlocks(supplied.blocks, recomputed.blocks));
  return checks;
}

function compareFiles(supplied: ChangedFileDigest[], recomputed: ChangedFileDigest[]): FileVerification[] {
  const checks: FileVerification[] = [];
  const recomputedByPath = new Map(recomputed.map((file) => [file.path, file]));

  for (const file of supplied) {
    const expected = recomputedByPath.get(file.path);
    if (expected === undefined) {
      checks.push({ path: file.path, ok: false, reason: "file is not changed in the referenced commit" });
      continue;
    }
    checks.push(compareValue(file.path, "file metadata", normalizedFile(file), normalizedFile(expected)));
    recomputedByPath.delete(file.path);
  }

  for (const path of recomputedByPath.keys()) {
    checks.push({ path, ok: false, reason: "file is missing from supplied digest" });
  }

  return checks;
}

function compareBlocks(supplied: LineMoveBlock[], recomputed: LineMoveBlock[]): FileVerification[] {
  const checks: FileVerification[] = [];
  const recomputedById = new Map(recomputed.map((block) => [block.id, block]));

  for (const block of supplied) {
    const expected = recomputedById.get(block.id);
    if (expected === undefined) {
      checks.push({ path: `block:${block.id}`, ok: false, reason: "block is not present in recomputed digest" });
      continue;
    }
    checks.push(compareValue(`block:${block.id}`, "block facts", normalizedBlock(block), normalizedBlock(expected)));
    recomputedById.delete(block.id);
  }

  for (const id of recomputedById.keys()) {
    checks.push({ path: `block:${id}`, ok: false, reason: "block is missing from supplied digest" });
  }

  return checks;
}

function normalizedFile(file: ChangedFileDigest): unknown {
  return {
    path: file.path,
    old_exists: file.old_exists,
    new_exists: file.new_exists,
    old_mode: file.old_mode,
    new_mode: file.new_mode,
    old_oid: file.old_oid,
    new_oid: file.new_oid,
    binary: file.binary,
    old_lines: file.old_lines,
    new_lines: file.new_lines,
    old_sha256: file.old_sha256,
    new_sha256: file.new_sha256,
    line_digest_status: file.line_digest_status,
    unsupported_reason: file.unsupported_reason
  };
}

function normalizedBlock(block: LineMoveBlock): unknown {
  return {
    id: block.id,
    kind: block.kind,
    src: block.src,
    dst: block.dst,
    payload_sha256: block.payload_sha256,
    payload_bytes: block.payload_bytes,
    payload_lines: block.payload_lines,
    payload_encoding: block.payload_encoding,
    payload_text: block.payload_text,
    payload_base64: block.payload_base64
  };
}

function compareValue(path: string, label: string, supplied: unknown, expected: unknown): FileVerification {
  const left = JSON.stringify(supplied);
  const right = JSON.stringify(expected);
  if (left === right) {
    return { path, ok: true };
  }
  return { path, ok: false, reason: `${label} does not match recomputed digest` };
}

function verifyFile(path: string, state: FileState, blocks: LineMoveBlock[]): FileVerification {
  try {
    const reconstructed = reconstructNewFile(path, state.oldLines, blocks);
    const expected = state.newBytes ?? Buffer.alloc(0);
    if (!reconstructed.equals(expected)) {
      return {
        path,
        ok: false,
        reason: `reconstructed ${reconstructed.length} bytes but the commit has ${expected.length} bytes`
      };
    }
    return { path, ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { path, ok: false, reason: message };
  }
}

function reconstructNewFile(path: string, oldLines: LineRecord[], blocks: LineMoveBlock[]): Buffer {
  const removedLineNos = new Set<number>();
  for (const block of blocks) {
    if (block.src?.path !== path) {
      continue;
    }
    for (let lineNo = block.src.start_line; lineNo <= block.src.end_line; lineNo += 1) {
      if (removedLineNos.has(lineNo)) {
        throw new Error(`line ${lineNo} is removed by more than one block`);
      }
      removedLineNos.add(lineNo);
    }
  }
  if (removedLineNos.size > 0 && Math.max(...removedLineNos) > oldLines.length) {
    throw new Error("a source span reaches past the end of the parent file");
  }

  const retained = oldLines.filter((line) => !removedLineNos.has(line.lineNo));
  const dstBlocks = blocks
    .filter((block) => block.dst?.path === path)
    .sort((left, right) => left.dst!.start_line - right.dst!.start_line);

  const chunks: Buffer[] = [];
  let retainedIndex = 0;
  let nextLineNo = 1;
  for (const block of dstBlocks) {
    const dst = block.dst!;
    if (dst.start_line < nextLineNo) {
      throw new Error(`destination spans overlap at line ${dst.start_line}`);
    }
    while (nextLineNo < dst.start_line) {
      const line = retained[retainedIndex];
      if (line === undefined) {
        throw new Error(`no retained parent line available for new line ${nextLineNo}`);
      }
      chunks.push(line.bytes);
      retainedIndex += 1;
      nextLineNo += 1;
    }
    chunks.push(decodePayload(block));
    nextLineNo = dst.end_line + 1;
  }
  for (; retainedIndex < retained.length; retainedIndex += 1) {
    chunks.push(retained[retainedIndex].bytes);
  }

  return Buffer.concat(chunks);
}

function decodePayload(block: LineMoveBlock): Buffer {
  if (block.payload_encoding === "base64") {
    if (block.payload_base64 === undefined) {
      throw new Error("payload_encoding is base64 but payload_base64 is missing");
    }
    return Buffer.from(block.payload_base64, "base64");
  }
  if (block.payload_text === undefined) {
    throw new Error("payload_encoding is utf-8 but payload_text is missing");
  }
  return Buffer.from(block.payload_text, "utf8");
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
