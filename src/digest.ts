import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { lineId, renderBlockPatch, type RenderContext } from "./blockpatch";
import { getCommitInfo, readChangedFilePairs, type FilePair } from "./git";
import { deriveIdentity } from "./identity";
import {
  concatLineBytes,
  isBinary,
  spanForLines,
  splitLineRecords,
  type LineRecord
} from "./lines";
import {
  schemaVersion,
  type BlockKind,
  type BlockCommitDigest,
  type ChangedFileDigest,
  type LineDigestStatus,
  type LineMoveBlock,
  type LineSpan,
  type MatchMetadata,
  type UnsupportedReason,
  type PayloadEncoding
} from "./types";

interface RemovedLine {
  line: LineRecord;
  paired?: AddedLine;
}

interface AddedLine {
  line: LineRecord;
  insertBeforeLine: number;
  paired?: RemovedLine;
}

interface ParsedChanges {
  removed: RemovedLine[];
  added: AddedLine[];
  sawHunk: boolean;
}

interface PairedLine {
  src: RemovedLine;
  dst: AddedLine;
  match: MatchMetadata;
}

interface BlockDraft {
  srcLines: LineRecord[] | null;
  dstLines: LineRecord[] | null;
  pairedLines?: PairedLine[];
  targetInsertBeforeLine?: number;
}

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export interface DigestOptions {
  cwd?: string;
  commit?: string;
}

export interface FileState {
  oldLines: LineRecord[];
  newBytes: Buffer | null;
}

export interface DigestComputation {
  digest: BlockCommitDigest;
  fileStates: Map<string, FileState>;
}

export function digestCommit(options: DigestOptions = {}): BlockCommitDigest {
  return computeDigest(options).digest;
}

export function computeDigest(options: DigestOptions = {}): DigestComputation {
  const cwd = options.cwd ?? process.cwd();
  const info = getCommitInfo(cwd, options.commit ?? "HEAD");
  const pairs = readChangedFilePairs(info);
  const oldLinesByPath = new Map<string, LineRecord[]>();
  const oldExists = new Set<string>();
  const newExists = new Set<string>();
  const fileStates = new Map<string, FileState>();
  const fileDigests: ChangedFileDigest[] = [];
  const removed: RemovedLine[] = [];
  const added: AddedLine[] = [];

  for (const pair of pairs) {
    const oldBytes = pair.oldBytes ?? Buffer.alloc(0);
    const newBytes = pair.newBytes ?? Buffer.alloc(0);
    const binary = pair.gitBinary || isBinary(oldBytes) || isBinary(newBytes);
    const oldLines = splitLineRecords(pair.path, oldBytes);
    const newLines = splitLineRecords(pair.path, newBytes);
    const status = classifyFile(pair, binary, oldBytes, newBytes);
    const shouldParseLines = status.reason === undefined || status.reason === "mode_only";
    const parsed = shouldParseLines
      ? parseChangedLines(pair, oldLines, newLines)
      : emptyParsedChanges();
    const finalStatus = finalizeFileStatus(status, parsed, oldBytes, newBytes, oldLines, newLines);

    oldLinesByPath.set(pair.path, oldLines);
    fileStates.set(pair.path, { oldLines, newBytes: pair.newBytes });
    if (pair.oldExists) {
      oldExists.add(pair.path);
    }
    if (pair.newExists) {
      newExists.add(pair.path);
    }
    fileDigests.push({
      path: pair.path,
      old_exists: pair.oldExists,
      new_exists: pair.newExists,
      old_mode: pair.oldMode,
      new_mode: pair.newMode,
      old_oid: pair.oldOid,
      new_oid: pair.newOid,
      binary,
      old_lines: oldLines.length,
      new_lines: newLines.length,
      old_sha256: pair.oldBytes === null ? null : sha256(pair.oldBytes),
      new_sha256: pair.newBytes === null ? null : sha256(pair.newBytes),
      line_digest_status: finalStatus.lineDigestStatus,
      ...(finalStatus.reason === undefined ? {} : { unsupported_reason: finalStatus.reason })
    });

    if (finalStatus.lineDigestStatus === "represented" || finalStatus.lineDigestStatus === "partial") {
      removed.push(...parsed.removed);
      added.push(...parsed.added);
    }
  }

  const paired = pairLines(removed, added);
  const drafts = [
    ...groupPairedLines(paired),
    ...groupOneSidedLines(
      added.filter((line) => line.paired === undefined),
      "added"
    ),
    ...groupOneSidedLines(
      removed.filter((line) => line.paired === undefined),
      "removed"
    )
  ];

  const renderContext: RenderContext = {
    oldLinesByPath,
    oldExists,
    newExists,
    removedLineIds: new Set(removed.map((line) => lineId(line.line.path, line.line.lineNo)))
  };
  const blocks = drafts.map((draft) => buildBlock(draft, renderContext));
  const rendered = blocks.filter((block) => block.blockpatch.status === "rendered").length;

  const digest: BlockCommitDigest = {
    schema_version: schemaVersion,
    commit: info.commit,
    parent: info.parent,
    repo: info.repo,
    files: fileDigests,
    blocks,
    identity: deriveIdentity(fileDigests, blocks),
    summary: {
      files: fileDigests.length,
      blocks: blocks.length,
      moves: blocks.filter((block) => block.kind === "move").length,
      insertions: blocks.filter((block) => block.kind === "insert").length,
      deletions: blocks.filter((block) => block.kind === "delete").length,
      rendered_blockpatches: rendered,
      unsupported_blockpatches: blocks.length - rendered
    }
  };

  return { digest, fileStates };
}

interface InitialFileStatus {
  reason?: UnsupportedReason;
}

interface FinalFileStatus {
  lineDigestStatus: LineDigestStatus;
  reason?: UnsupportedReason;
}

function emptyParsedChanges(): ParsedChanges {
  return { removed: [], added: [], sawHunk: false };
}

function classifyFile(pair: FilePair, binary: boolean, oldBytes: Buffer, newBytes: Buffer): InitialFileStatus {
  const modeChanged = pair.oldMode !== null && pair.newMode !== null && pair.oldMode !== pair.newMode;
  if (pair.oldMode === "160000" || pair.newMode === "160000") {
    return { reason: "submodule" };
  }
  if (pair.oldMode !== null && pair.newMode !== null && fileType(pair.oldMode) !== fileType(pair.newMode)) {
    return { reason: "filetype" };
  }
  if (binary) {
    return { reason: "binary" };
  }
  if (pair.unparsedDiff) {
    return { reason: "unparsed_diff" };
  }
  if (modeChanged && buffersEqual(oldBytes, newBytes)) {
    return { reason: "mode_only" };
  }
  if (modeChanged) {
    return { reason: "mode_only" };
  }
  return {};
}

function finalizeFileStatus(
  initial: InitialFileStatus,
  parsed: ParsedChanges,
  oldBytes: Buffer,
  newBytes: Buffer,
  oldLines: LineRecord[],
  newLines: LineRecord[]
): FinalFileStatus {
  if (
    initial.reason === undefined &&
    !buffersEqual(oldBytes, newBytes) &&
    oldLines.length + newLines.length > 0 &&
    !parsed.sawHunk
  ) {
    return { lineDigestStatus: "unsupported", reason: "unparsed_diff" };
  }

  if (initial.reason === undefined) {
    return { lineDigestStatus: "represented" };
  }

  if (initial.reason === "mode_only" && !buffersEqual(oldBytes, newBytes)) {
    return { lineDigestStatus: "partial", reason: "mode_only" };
  }

  return { lineDigestStatus: "unsupported", reason: initial.reason };
}

function fileType(mode: string): string {
  return mode.slice(0, 2);
}

function buffersEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && left.equals(right);
}

function parseChangedLines(pair: FilePair, oldLines: LineRecord[], newLines: LineRecord[]): ParsedChanges {
  const removed: RemovedLine[] = [];
  const added: AddedLine[] = [];
  const lines = pair.diff.split("\n");
  let oldCursor = 0;
  let newCursor = 0;
  let inHunk = false;
  let sawHunk = false;

  for (const raw of lines) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
    if (hunk !== null) {
      inHunk = true;
      sawHunk = true;
      const oldStart = Number(hunk[1]);
      const oldCount = hunk[2] === undefined ? 1 : Number(hunk[2]);
      oldCursor = oldCount === 0 ? oldStart + 1 : oldStart;
      newCursor = Number(hunk[3]);
      continue;
    }

    if (!inHunk || raw.length === 0) {
      continue;
    }

    const prefix = raw[0];
    if (prefix === "\\") {
      continue;
    }

    if (prefix === "-") {
      const line = oldLines[oldCursor - 1];
      if (line !== undefined) {
        removed.push({ line });
      }
      oldCursor += 1;
      continue;
    }

    if (prefix === "+") {
      const line = newLines[newCursor - 1];
      if (line !== undefined) {
        const insertBeforeLine = oldCursor === 0 ? 1 : oldCursor;
        added.push({ line, insertBeforeLine });
      }
      newCursor += 1;
      continue;
    }

    if (prefix === " ") {
      oldCursor += 1;
      newCursor += 1;
      continue;
    }

    inHunk = false;
  }

  return { removed, added, sawHunk };
}

// Pairs removed and added lines patience-style: lines whose content is unique
// on both sides anchor a pairing, then each anchor extends through adjacent
// lines with equal content so non-unique neighbors (blank lines, braces) join
// a block only when its context carries them. Anchoring repeats on the
// leftovers until no unique content remains, so coincidentally identical
// trivial lines never pair into phantom moves.
//
// A line may only anchor if it carries enough alphanumeric content to
// plausibly have an identity of its own (compare git's --color-moved
// MIN_ALNUM_COUNT); blank lines and lone braces can join a block through
// extension but never start one. Whole-file binary records are exempt:
// exact byte equality of an entire file is strong evidence on its own.
function pairLines(removed: RemovedLine[], added: AddedLine[]): PairedLine[] {
  const paired: PairedLine[] = [];
  const removedByPos = new Map<string, RemovedLine>();
  const addedByPos = new Map<string, AddedLine>();
  for (const line of removed) {
    removedByPos.set(lineId(line.line.path, line.line.lineNo), line);
  }
  for (const line of added) {
    addedByPos.set(lineId(line.line.path, line.line.lineNo), line);
  }

  while (true) {
    const before = paired.length;
    const anchors = uniqueContentAnchors(removed, added);
    if (anchors.length === 0) {
      break;
    }
    for (const anchor of anchors) {
      if (anchor.src.paired !== undefined || anchor.dst.paired !== undefined) {
        continue;
      }
      pairUp(anchor.src, anchor.dst, paired);
      extendPairing(anchor, 1, removedByPos, addedByPos, paired);
      extendPairing(anchor, -1, removedByPos, addedByPos, paired);
    }
    if (paired.length === before) {
      break;
    }
  }

  annotateMatchMetadata(paired, removed, added);
  return paired;
}

const anchorMinAlnum = 4;
const alnumPattern = /[\p{L}\p{N}]/gu;

function canAnchor(line: LineRecord): boolean {
  if (line.atomic === true) {
    return true;
  }
  return (line.key.match(alnumPattern)?.length ?? 0) >= anchorMinAlnum;
}

function uniqueContentAnchors(removed: RemovedLine[], added: AddedLine[]): PairedLine[] {
  const srcByKey = new Map<string, RemovedLine | null>();
  for (const line of removed) {
    if (line.paired !== undefined || !canAnchor(line.line)) {
      continue;
    }
    srcByKey.set(line.line.key, srcByKey.has(line.line.key) ? null : line);
  }

  const dstByKey = new Map<string, AddedLine | null>();
  for (const line of added) {
    if (line.paired !== undefined || !canAnchor(line.line)) {
      continue;
    }
    dstByKey.set(line.line.key, dstByKey.has(line.line.key) ? null : line);
  }

  const anchors: PairedLine[] = [];
  for (const [key, src] of srcByKey) {
    if (src === null) {
      continue;
    }
    const dst = dstByKey.get(key);
    if (dst === undefined || dst === null) {
      continue;
    }
    anchors.push({ src, dst, match: defaultMatchMetadata() });
  }
  return anchors;
}

function extendPairing(
  anchor: PairedLine,
  step: 1 | -1,
  removedByPos: Map<string, RemovedLine>,
  addedByPos: Map<string, AddedLine>,
  paired: PairedLine[]
): void {
  let src = anchor.src.line;
  let dst = anchor.dst.line;

  while (true) {
    const nextSrc = removedByPos.get(lineId(src.path, src.lineNo + step));
    const nextDst = addedByPos.get(lineId(dst.path, dst.lineNo + step));
    if (nextSrc === undefined || nextDst === undefined) {
      return;
    }
    if (nextSrc.paired !== undefined || nextDst.paired !== undefined) {
      return;
    }
    if (nextSrc.line.key !== nextDst.line.key) {
      return;
    }
    pairUp(nextSrc, nextDst, paired);
    src = nextSrc.line;
    dst = nextDst.line;
  }
}

function pairUp(src: RemovedLine, dst: AddedLine, paired: PairedLine[]): void {
  src.paired = dst;
  dst.paired = src;
  paired.push({ src, dst, match: defaultMatchMetadata() });
}

function annotateMatchMetadata(paired: PairedLine[], removed: RemovedLine[], added: AddedLine[]): void {
  const removedCounts = countByLineKey(removed.map((line) => line.line));
  const addedCounts = countByLineKey(added.map((line) => line.line));

  for (const pair of paired) {
    const duplicateRemovedCandidates = Math.max(0, (removedCounts.get(pair.src.line.key) ?? 0) - 1);
    const duplicateAddedCandidates = Math.max(0, (addedCounts.get(pair.dst.line.key) ?? 0) - 1);
    pair.match = {
      algorithm: "exact-line-sha256-patience",
      ambiguous: duplicateRemovedCandidates > 0 || duplicateAddedCandidates > 0,
      duplicate_removed_candidates: duplicateRemovedCandidates,
      duplicate_added_candidates: duplicateAddedCandidates
    };
  }
}

function countByLineKey(lines: LineRecord[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of lines) {
    counts.set(line.key, (counts.get(line.key) ?? 0) + 1);
  }
  return counts;
}

function defaultMatchMetadata(): MatchMetadata {
  return {
    algorithm: "exact-line-sha256-patience",
    ambiguous: false,
    duplicate_removed_candidates: 0,
    duplicate_added_candidates: 0
  };
}

function groupPairedLines(paired: PairedLine[]): BlockDraft[] {
  const sorted = [...paired].sort((left, right) =>
    compareLineRecords(left.src.line, right.src.line) || compareLineRecords(left.dst.line, right.dst.line)
  );
  const groups: PairedLine[][] = [];

  for (const line of sorted) {
    const group = groups.at(-1);
    const previous = group?.at(-1);
    if (group !== undefined && previous !== undefined && adjacentPair(previous, line)) {
      group.push(line);
    } else {
      groups.push([line]);
    }
  }

  return groups.map((group) => ({
    srcLines: group.map((line) => line.src.line),
    dstLines: group.map((line) => line.dst.line),
    pairedLines: group,
    targetInsertBeforeLine: group[0].dst.insertBeforeLine
  }));
}

function groupOneSidedLines(lines: AddedLine[], kind: "added"): BlockDraft[];
function groupOneSidedLines(lines: RemovedLine[], kind: "removed"): BlockDraft[];
function groupOneSidedLines(lines: AddedLine[] | RemovedLine[], kind: "added" | "removed"): BlockDraft[] {
  const sorted = [...lines].sort((left, right) => compareLineRecords(left.line, right.line));
  const groups: Array<typeof sorted> = [];

  for (const line of sorted) {
    const group = groups.at(-1);
    const previous = group?.at(-1);
    if (group !== undefined && previous !== undefined && adjacentOneSided(previous, line, kind)) {
      group.push(line);
    } else {
      groups.push([line]);
    }
  }

  return groups.map((group) => {
    if (kind === "added") {
      const added = group as AddedLine[];
      return {
        srcLines: null,
        dstLines: added.map((line) => line.line),
        targetInsertBeforeLine: added[0].insertBeforeLine
      };
    }
    return {
      srcLines: (group as RemovedLine[]).map((line) => line.line),
      dstLines: null
    };
  });
}

function adjacentPair(previous: PairedLine, current: PairedLine): boolean {
  return (
    samePath(previous.src.line, current.src.line) &&
    samePath(previous.dst.line, current.dst.line) &&
    previous.src.line.lineNo + 1 === current.src.line.lineNo &&
    previous.dst.line.lineNo + 1 === current.dst.line.lineNo &&
    previous.src.line.byteEnd === current.src.line.byteStart &&
    previous.dst.line.byteEnd === current.dst.line.byteStart
  );
}

function adjacentOneSided(previous: AddedLine | RemovedLine, current: AddedLine | RemovedLine, kind: "added" | "removed"): boolean {
  const lineAdjacent =
    samePath(previous.line, current.line) &&
    previous.line.lineNo + 1 === current.line.lineNo &&
    previous.line.byteEnd === current.line.byteStart;

  if (!lineAdjacent || kind === "removed") {
    return lineAdjacent;
  }

  return (previous as AddedLine).insertBeforeLine === (current as AddedLine).insertBeforeLine;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function buildBlock(draft: BlockDraft, context: RenderContext): LineMoveBlock {
  const srcLines = draft.srcLines;
  const dstLines = draft.dstLines;
  const payload = srcLines !== null ? concatLineBytes(srcLines) : concatLineBytes(dstLines ?? []);
  const hash = sha256(payload);
  const kind: BlockKind = srcLines !== null && dstLines !== null ? "move" : srcLines === null ? "insert" : "delete";
  const src = srcLines === null ? null : spanForLines(srcLines);
  const dst = dstLines === null ? null : spanForLines(dstLines);
  const id = stableBlockId(kind, src, dst, hash);
  const blockpatch = safeRenderBlockPatch({
    id,
    srcLines,
    dstLines,
    payload,
    targetInsertBeforeLine: draft.targetInsertBeforeLine
  }, context);
  const encoded = encodePayload(payload);

  return {
    id,
    kind,
    src,
    dst,
    payload_sha256: hash,
    payload_bytes: payload.length,
    payload_lines: srcLines?.length ?? dstLines?.length ?? 0,
    payload_encoding: encoded.encoding,
    ...encoded.fields,
    match: blockMatchMetadata(draft),
    blockpatch
  };
}

function stableBlockId(kind: BlockKind, src: LineSpan | null, dst: LineSpan | null, payloadSha: string): string {
  const hash = createHash("sha256")
    .update(kind)
    .update("\0")
    .update(src === null ? "null" : JSON.stringify(src))
    .update("\0")
    .update(dst === null ? "null" : JSON.stringify(dst))
    .update("\0")
    .update(payloadSha)
    .digest("hex");
  return `bc_${hash.slice(0, 16)}`;
}

function blockMatchMetadata(draft: BlockDraft): MatchMetadata {
  const pairs = draft.pairedLines ?? [];
  if (pairs.length === 0) {
    return defaultMatchMetadata();
  }

  return {
    algorithm: "exact-line-sha256-patience",
    ambiguous: pairs.some((pair) => pair.match.ambiguous),
    duplicate_removed_candidates: Math.max(...pairs.map((pair) => pair.match.duplicate_removed_candidates)),
    duplicate_added_candidates: Math.max(...pairs.map((pair) => pair.match.duplicate_added_candidates))
  };
}

function safeRenderBlockPatch(
  block: {
    id: string;
    srcLines: LineRecord[] | null;
    dstLines: LineRecord[] | null;
    payload: Buffer;
    targetInsertBeforeLine?: number;
  },
  context: RenderContext
): LineMoveBlock["blockpatch"] {
  try {
    return renderBlockPatch(block, context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: "unsupported", reason: message };
  }
}

function compareLineRecords(left: LineRecord, right: LineRecord): number {
  return left.path.localeCompare(right.path) || left.lineNo - right.lineNo;
}

function samePath(left: LineRecord, right: LineRecord): boolean {
  return left.path === right.path;
}

function encodePayload(bytes: Buffer): {
  encoding: PayloadEncoding;
  fields: { payload_text: string } | { payload_base64: string };
} {
  try {
    return { encoding: "utf-8", fields: { payload_text: utf8Decoder.decode(bytes) } };
  } catch {
    return { encoding: "base64", fields: { payload_base64: bytes.toString("base64") } };
  }
}
