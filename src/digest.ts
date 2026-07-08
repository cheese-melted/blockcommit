import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { getCommitInfo, readChangedFilePairs, type CommitInfo, type FilePair } from "./git";
import { deriveIdentity } from "./identity";
import {
  concatLineBytes,
  isBinary,
  spanForLines,
  splitLineRecords,
  type LineRecord
} from "./lines";
import {
  digestAlgorithm,
  schemaVersion,
  type BlockKind,
  type BlockCommitDigest,
  type ChangedFileDigest,
  type LineDigestStatus,
  type LineMoveBlock,
  type LineSpan,
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
  chosenBy: PairingStage;
}

type PairingStage = "unique_anchor" | "whole_file_identity" | "dominant_path_identity" | "exact_block_fallback" | "unpaired";

interface LineOccurrenceCounts {
  old: Map<string, number>;
  new: Map<string, number>;
}

interface BlockDraft {
  srcLines: LineRecord[] | null;
  dstLines: LineRecord[] | null;
  pairedLines?: PairedLine[];
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
  return computeDigestFor(getCommitInfo(cwd, options.commit ?? "HEAD"));
}

export function computeDigestFor(info: CommitInfo): DigestComputation {
  const pairs = readChangedFilePairs(info);
  const fileStates = new Map<string, FileState>();
  const fileDigests: ChangedFileDigest[] = [];
  const removed: RemovedLine[] = [];
  const added: AddedLine[] = [];
  const lineOccurrences: LineOccurrenceCounts = { old: new Map(), new: new Map() };

  for (const pair of pairs) {
    const oldBytes = pair.oldBytes ?? Buffer.alloc(0);
    const newBytes = pair.newBytes ?? Buffer.alloc(0);
    const binary = pair.gitBinary || isBinary(oldBytes) || isBinary(newBytes);
    const oldLines = splitLineRecords(pair.path, oldBytes);
    const newLines = splitLineRecords(pair.path, newBytes);
    countLineOccurrences(lineOccurrences.old, oldLines);
    countLineOccurrences(lineOccurrences.new, newLines);
    const status = classifyFile(pair, binary, oldBytes, newBytes);
    const shouldParseLines = status.reason === undefined;
    const parsed = shouldParseLines
      ? parseChangedLines(pair, oldLines, newLines)
      : emptyParsedChanges();
    const finalStatus = finalizeFileStatus(status, parsed, oldBytes, newBytes, oldLines, newLines);

    fileStates.set(pair.path, { oldLines, newBytes: pair.newBytes });
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

    if (finalStatus.lineDigestStatus === "represented") {
      removed.push(...parsed.removed);
      added.push(...parsed.added);
    }
  }

  const paired = pairLines(removed, added, fileDigests, lineOccurrences);
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

  const builtBlocks = drafts.map((draft) => buildBlock(draft));
  const blocks = builtBlocks.map((built) => built.block);

  const digest: BlockCommitDigest = {
    schema_version: schemaVersion,
    algorithm: digestAlgorithm,
    commit: info.commit,
    parent: info.parent,
    files: fileDigests,
    blocks,
    identity: deriveIdentity(fileDigests, blocks),
    summary: {
      files: fileDigests.length,
      blocks: blocks.length,
      moves: blocks.filter((block) => block.kind === "move").length,
      insertions: blocks.filter((block) => block.kind === "insert").length,
      deletions: blocks.filter((block) => block.kind === "delete").length
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

  return { lineDigestStatus: "unsupported", reason: initial.reason };
}

function fileType(mode: string): string {
  return mode.slice(0, 2);
}

function buffersEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && left.equals(right);
}

function countLineOccurrences(counts: Map<string, number>, lines: LineRecord[]): void {
  for (const line of lines) {
    counts.set(line.key, (counts.get(line.key) ?? 0) + 1);
  }
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

// Pairs removed and added lines in identity-preserving stages: whole-file
// identity first, then snapshot-unique anchors, then exact leftovers supported
// by dominant path identity, and finally conservative exact block fallback.
// Anchors extend through adjacent lines with equal content so non-unique
// neighbors (blank lines, braces) join a block only when its context carries
// them. Anchoring repeats on the leftovers until no unique content remains, so
// coincidentally identical trivial lines never pair into phantom moves.
//
// A line may only anchor if it carries enough alphanumeric content to
// plausibly have an identity of its own (compare git's --color-moved
// MIN_ALNUM_COUNT); blank lines and lone braces can join a block through
// extension but never start one.
function pairLines(
  removed: RemovedLine[],
  added: AddedLine[],
  files: ChangedFileDigest[],
  lineOccurrences: LineOccurrenceCounts
): PairedLine[] {
  const paired: PairedLine[] = [];
  const removedByPos = new Map<string, RemovedLine>();
  const addedByPos = new Map<string, AddedLine>();
  for (const line of removed) {
    removedByPos.set(lineId(line.line.path, line.line.lineNo), line);
  }
  for (const line of added) {
    addedByPos.set(lineId(line.line.path, line.line.lineNo), line);
  }

  pairWholeFileIdentityMoves(removed, added, files, paired);

  while (true) {
    const before = paired.length;
    const anchors = uniqueContentAnchors(removed, added, lineOccurrences);
    if (anchors.length === 0) {
      break;
    }
    for (const anchor of anchors) {
      if (anchor.src.paired !== undefined || anchor.dst.paired !== undefined) {
        continue;
      }
      const pairedAnchor = pairUp(anchor.src, anchor.dst, paired, "unique_anchor");
      extendPairing(pairedAnchor, 1, removedByPos, addedByPos, paired);
      extendPairing(pairedAnchor, -1, removedByPos, addedByPos, paired);
    }
    if (paired.length === before) {
      break;
    }
  }

  pairDominantPathIdentityBlocks(removed, added, files, paired);
  pairExactUnmatchedBlocksByObjective(removed, added, paired);
  return paired;
}

const anchorMinAlnum = digestAlgorithm.anchor_min_alnum;
const nonAsciiAlnum = /[\p{L}\p{N}]/u;

// Memoized on the record: pairLines re-anchors until it reaches a fixed
// point, and this check dominated digest time when recomputed per round.
function canAnchor(line: LineRecord): boolean {
  line.anchorEligible ??= hasAnchorContent(line.key);
  return line.anchorEligible;
}

// key is latin1-decoded, so every character is a single code unit below
// 0x100; ASCII alphanumerics short-circuit the Unicode class.
function hasAnchorContent(key: string): boolean {
  let count = 0;
  for (let index = 0; index < key.length; index += 1) {
    const code = key.charCodeAt(index);
    const alnum =
      (code >= 0x30 && code <= 0x39) ||
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x80 && nonAsciiAlnum.test(key[index]));
    if (!alnum) {
      continue;
    }
    count += 1;
    if (count >= anchorMinAlnum) {
      return true;
    }
  }
  return false;
}

function uniqueContentAnchors(
  removed: RemovedLine[],
  added: AddedLine[],
  lineOccurrences: LineOccurrenceCounts
): PairedLine[] {
  const srcByKey = new Map<string, RemovedLine | null>();
  for (const line of removed) {
    if (line.paired !== undefined || !canAnchor(line.line) || !isSnapshotUnique(line.line, lineOccurrences.old)) {
      continue;
    }
    srcByKey.set(line.line.key, srcByKey.has(line.line.key) ? null : line);
  }

  const dstByKey = new Map<string, AddedLine | null>();
  for (const line of added) {
    if (line.paired !== undefined || !canAnchor(line.line) || !isSnapshotUnique(line.line, lineOccurrences.new)) {
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
    anchors.push({ src, dst, chosenBy: "unique_anchor" });
  }
  return anchors;
}

function isSnapshotUnique(line: LineRecord, counts: Map<string, number>): boolean {
  return (counts.get(line.key) ?? 0) === 1;
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
    pairUp(nextSrc, nextDst, paired, anchor.chosenBy);
    src = nextSrc.line;
    dst = nextDst.line;
  }
}

function pairUp(
  src: RemovedLine,
  dst: AddedLine,
  paired: PairedLine[],
  chosenBy: PairingStage = "unique_anchor"
): PairedLine {
  src.paired = dst;
  dst.paired = src;
  const pair = { src, dst, chosenBy };
  paired.push(pair);
  return pair;
}

function pairWholeFileIdentityMoves(
  removed: RemovedLine[],
  added: AddedLine[],
  files: ChangedFileDigest[],
  paired: PairedLine[]
): void {
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const removedGroups = groupUnpairedRemovedLines(removed).filter((group) => isCompleteOldFileGroup(group, filesByPath));
  const addedGroups = groupUnpairedAddedLines(added).filter((group) => isCompleteNewFileGroup(group, filesByPath));
  const removedByPayload = uniqueGroupsByPayload(removedGroups);
  const addedByPayload = uniqueGroupsByPayload(addedGroups);

  for (const [payloadKey, srcGroup] of removedByPayload) {
    if (srcGroup === null || !pairableExactFallbackGroup(srcGroup)) {
      continue;
    }
    const dstGroup = addedByPayload.get(payloadKey);
    if (dstGroup === undefined || dstGroup === null || srcGroup.length !== dstGroup.length) {
      continue;
    }
    for (let index = 0; index < srcGroup.length; index += 1) {
      pairUp(srcGroup[index], dstGroup[index] as AddedLine, paired, "whole_file_identity");
    }
  }
}

function isCompleteOldFileGroup(group: RemovedLine[], filesByPath: Map<string, ChangedFileDigest>): boolean {
  const file = filesByPath.get(group[0]?.line.path ?? "");
  return (
    file !== undefined &&
    file.old_exists &&
    file.old_lines > 0 &&
    file.old_lines === group.length &&
    group[0]?.line.lineNo === 1 &&
    group.at(-1)?.line.lineNo === file.old_lines
  );
}

function isCompleteNewFileGroup(group: AddedLine[], filesByPath: Map<string, ChangedFileDigest>): boolean {
  const file = filesByPath.get(group[0]?.line.path ?? "");
  return (
    file !== undefined &&
    file.new_exists &&
    file.new_lines > 0 &&
    file.new_lines === group.length &&
    group[0]?.line.lineNo === 1 &&
    group.at(-1)?.line.lineNo === file.new_lines
  );
}

interface ExactBlockCandidate {
  srcGroup: RemovedLine[];
  dstGroup: AddedLine[];
  chosenBy: PairingStage;
  score: number;
}

function pairDominantPathIdentityBlocks(
  removed: RemovedLine[],
  added: AddedLine[],
  files: ChangedFileDigest[],
  paired: PairedLine[]
): void {
  const dominantPairs = dominantPathPairs(removed, added, files);
  if (dominantPairs.size === 0) {
    return;
  }

  const removedGroups = groupUnpairedRemovedLines(removed);
  const addedGroups = groupUnpairedAddedLines(added);
  const pairedBySrcPos = new Map(paired.map((pair) => [lineId(pair.src.line.path, pair.src.line.lineNo), pair]));
  const candidates: ExactBlockCandidate[] = [];

  for (const srcGroup of removedGroups) {
    for (const dstGroup of addedGroups) {
      if (!sameExactPayload(srcGroup, dstGroup) || !dominantPairs.has(pathPairKey(srcGroup[0].line.path, dstGroup[0].line.path))) {
        continue;
      }
      if (!pairableExactFallbackGroup(srcGroup) && !hasAdjacentPairedPathContext(srcGroup, dstGroup, pairedBySrcPos)) {
        continue;
      }
      candidates.push({
        srcGroup,
        dstGroup,
        chosenBy: "dominant_path_identity",
        score: exactBlockCandidateScore(srcGroup, dstGroup, true)
      });
    }
  }

  pairExactBlockCandidates(candidates, paired);
}

function dominantPathPairs(removed: RemovedLine[], added: AddedLine[], files: ChangedFileDigest[]): Set<string> {
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const removedByPath = lineKeyCountsByPath(removed);
  const addedByPath = lineKeyCountsByPath(added);
  const result = new Set<string>();

  for (const [srcPath, srcCounts] of removedByPath) {
    for (const [dstPath, dstCounts] of addedByPath) {
      if (srcPath === dstPath) {
        continue;
      }
      const overlap = multisetOverlap(srcCounts, dstCounts);
      if (overlap < 2) {
        continue;
      }
      const srcLineCount = filesByPath.get(srcPath)?.old_lines ?? totalLineCount(srcCounts);
      const dstLineCount = filesByPath.get(dstPath)?.new_lines ?? totalLineCount(dstCounts);
      if ((srcLineCount > 0 && overlap * 2 > srcLineCount) || (dstLineCount > 0 && overlap * 2 > dstLineCount)) {
        result.add(pathPairKey(srcPath, dstPath));
      }
    }
  }

  return result;
}

function lineKeyCountsByPath<T extends AddedLine | RemovedLine>(lines: T[]): Map<string, Map<string, number>> {
  const byPath = new Map<string, Map<string, number>>();
  for (const line of lines) {
    let counts = byPath.get(line.line.path);
    if (counts === undefined) {
      counts = new Map();
      byPath.set(line.line.path, counts);
    }
    counts.set(line.line.key, (counts.get(line.line.key) ?? 0) + 1);
  }
  return byPath;
}

function multisetOverlap(left: Map<string, number>, right: Map<string, number>): number {
  let overlap = 0;
  for (const [key, leftCount] of left) {
    overlap += Math.min(leftCount, right.get(key) ?? 0);
  }
  return overlap;
}

function totalLineCount(counts: Map<string, number>): number {
  let total = 0;
  for (const count of counts.values()) {
    total += count;
  }
  return total;
}

function hasAdjacentPairedPathContext(
  srcGroup: RemovedLine[],
  dstGroup: AddedLine[],
  pairedBySrcPos: Map<string, PairedLine>
): boolean {
  const firstSrc = srcGroup[0].line;
  const firstDst = dstGroup[0].line;
  const before = pairedBySrcPos.get(lineId(firstSrc.path, firstSrc.lineNo - 1));
  if (
    before !== undefined &&
    before.dst.line.path === firstDst.path &&
    before.dst.line.lineNo + 1 === firstDst.lineNo
  ) {
    return true;
  }

  const lastSrc = srcGroup.at(-1)!.line;
  const lastDst = dstGroup.at(-1)!.line;
  const after = pairedBySrcPos.get(lineId(lastSrc.path, lastSrc.lineNo + 1));
  return (
    after !== undefined &&
    after.dst.line.path === lastDst.path &&
    after.dst.line.lineNo - 1 === lastDst.lineNo
  );
}

function pairExactUnmatchedBlocksByObjective(removed: RemovedLine[], added: AddedLine[], paired: PairedLine[]): void {
  const removedGroupsByPayload = groupsByPayload(groupUnpairedRemovedLines(removed));
  const addedGroupsByPayload = groupsByPayload(groupUnpairedAddedLines(added));
  const candidates: ExactBlockCandidate[] = [];

  for (const [payloadKey, srcGroups] of removedGroupsByPayload) {
    if (srcGroups.length !== 1) {
      continue;
    }
    const dstGroups = addedGroupsByPayload.get(payloadKey);
    if (dstGroups === undefined || dstGroups.length !== 1) {
      continue;
    }
    const srcGroup = srcGroups[0];
    const dstGroup = dstGroups[0];
    if (!pairableExactFallbackGroup(srcGroup) || !sameExactPayload(srcGroup, dstGroup)) {
      continue;
    }
    if (srcGroup.length === 1) {
      continue;
    }
    candidates.push({
      srcGroup,
      dstGroup,
      chosenBy: "exact_block_fallback",
      score: exactBlockCandidateScore(srcGroup, dstGroup, false)
    });
  }

  pairExactBlockCandidates(candidates, paired);
}

function pairExactBlockCandidates(candidates: ExactBlockCandidate[], paired: PairedLine[]): void {
  const sorted = [...candidates].sort((left, right) =>
    right.score - left.score ||
    compareLineRecords(left.srcGroup[0].line, right.srcGroup[0].line) ||
    compareLineRecords(left.dstGroup[0].line, right.dstGroup[0].line)
  );

  for (const candidate of sorted) {
    if (candidate.srcGroup.some((line) => line.paired !== undefined) || candidate.dstGroup.some((line) => line.paired !== undefined)) {
      continue;
    }
    for (let index = 0; index < candidate.srcGroup.length; index += 1) {
      pairUp(candidate.srcGroup[index], candidate.dstGroup[index], paired, candidate.chosenBy);
    }
  }
}

function exactBlockCandidateScore(srcGroup: RemovedLine[], dstGroup: AddedLine[], hasDominantPathIdentity: boolean): number {
  const payloadBytes = concatLineBytes(srcGroup.map((line) => line.line)).length;
  return srcGroup.length * 1000 + payloadBytes + (hasDominantPathIdentity ? 500 : 0) - (srcGroup.length === 1 ? 250 : 0);
}

function sameExactPayload(srcGroup: RemovedLine[], dstGroup: AddedLine[]): boolean {
  return srcGroup.length === dstGroup.length && exactGroupPayloadKey(srcGroup) === exactGroupPayloadKey(dstGroup);
}

function pathPairKey(srcPath: string, dstPath: string): string {
  return `${srcPath}\0${dstPath}`;
}

function groupUnpairedRemovedLines(lines: RemovedLine[]): RemovedLine[][] {
  return groupUnpairedLines(lines, (previous, current) => adjacentOneSided(previous, current, "removed"));
}

function groupUnpairedAddedLines(lines: AddedLine[]): AddedLine[][] {
  return groupUnpairedLines(lines, (previous, current) => adjacentOneSided(previous, current, "added"));
}

function groupUnpairedLines<T extends AddedLine | RemovedLine>(
  lines: T[],
  adjacent: (previous: T, current: T) => boolean
): T[][] {
  const sorted = lines
    .filter((line) => line.paired === undefined)
    .sort((left, right) => compareLineRecords(left.line, right.line));
  const groups: T[][] = [];

  for (const line of sorted) {
    const group = groups.at(-1);
    const previous = group?.at(-1);
    if (group !== undefined && previous !== undefined && adjacent(previous, line)) {
      group.push(line);
    } else {
      groups.push([line]);
    }
  }

  return groups;
}

function uniqueGroupsByPayload<T extends AddedLine | RemovedLine>(groups: T[][]): Map<string, T[] | null> {
  const byPayload = new Map<string, T[] | null>();
  for (const group of groups) {
    const payloadKey = exactGroupPayloadKey(group);
    byPayload.set(payloadKey, byPayload.has(payloadKey) ? null : group);
  }
  return byPayload;
}

function groupsByPayload<T extends AddedLine | RemovedLine>(groups: T[][]): Map<string, T[][]> {
  const byPayload = new Map<string, T[][]>();
  for (const group of groups) {
    const payloadKey = exactGroupPayloadKey(group);
    const existing = byPayload.get(payloadKey);
    if (existing === undefined) {
      byPayload.set(payloadKey, [group]);
    } else {
      existing.push(group);
    }
  }
  return byPayload;
}

function exactGroupPayloadKey(group: Array<AddedLine | RemovedLine>): string {
  return `${group.length}\0${sha256(concatLineBytes(group.map((line) => line.line)))}`;
}

function pairableExactFallbackGroup(group: Array<AddedLine | RemovedLine>): boolean {
  return hasAnchorContent(concatLineBytes(group.map((line) => line.line)).toString("latin1"));
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
    pairedLines: group
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
        dstLines: added.map((line) => line.line)
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

function lineId(path: string, lineNo: number): string {
  return `${path}\0${lineNo}`;
}

interface BuiltBlock {
  block: LineMoveBlock;
}

function buildBlock(draft: BlockDraft): BuiltBlock {
  const srcLines = draft.srcLines;
  const dstLines = draft.dstLines;
  const payload = srcLines !== null ? concatLineBytes(srcLines) : concatLineBytes(dstLines ?? []);
  const hash = sha256(payload);
  const kind: BlockKind = srcLines !== null && dstLines !== null ? "move" : srcLines === null ? "insert" : "delete";
  const src = srcLines === null ? null : spanForLines(srcLines);
  const dst = dstLines === null ? null : spanForLines(dstLines);
  const id = stableBlockId(kind, src, dst, hash);
  const encoded = encodePayload(payload);
  const base = {
    id,
    payload_sha256: hash,
    payload_bytes: payload.length,
    payload_lines: srcLines?.length ?? dstLines?.length ?? 0,
    payload_encoding: encoded.encoding,
    ...encoded.fields
  };
  const block: LineMoveBlock = kind === "move"
    ? { ...base, kind, src: src!, dst: dst! }
    : kind === "insert"
      ? { ...base, kind, src: null, dst: dst! }
      : { ...base, kind, src: src!, dst: null };

  return { block };
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
