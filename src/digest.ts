import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { lineId, renderBlockPatch, type RenderContext } from "./blockpatch";
import { getCommitInfo, readChangedFilePairs, type FilePair } from "./git";
import { concatLineBytes, spanForLines, splitLineRecords, type LineRecord } from "./lines";
import { type BlockCommitDigest, type ChangedFileDigest, type LineMoveBlock } from "./types";

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
}

interface PairedLine {
  src: RemovedLine;
  dst: AddedLine;
}

interface BlockDraft {
  srcLines: LineRecord[] | null;
  dstLines: LineRecord[] | null;
  targetInsertBeforeLine?: number;
}

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export interface DigestOptions {
  cwd?: string;
  commit?: string;
}

export function digestCommit(options: DigestOptions = {}): BlockCommitDigest {
  const cwd = options.cwd ?? process.cwd();
  const info = getCommitInfo(cwd, options.commit ?? "HEAD");
  const pairs = readChangedFilePairs(info);
  const oldLinesByPath = new Map<string, LineRecord[]>();
  const oldExists = new Set<string>();
  const newExists = new Set<string>();
  const fileDigests: ChangedFileDigest[] = [];
  const removed: RemovedLine[] = [];
  const added: AddedLine[] = [];

  for (const pair of pairs) {
    const oldLines = splitLineRecords(pair.path, pair.oldBytes ?? Buffer.alloc(0));
    const newLines = splitLineRecords(pair.path, pair.newBytes ?? Buffer.alloc(0));
    oldLinesByPath.set(pair.path, oldLines);
    if (pair.oldBytes !== null) {
      oldExists.add(pair.path);
    }
    if (pair.newBytes !== null) {
      newExists.add(pair.path);
    }
    fileDigests.push({
      path: pair.path,
      old_exists: pair.oldBytes !== null,
      new_exists: pair.newBytes !== null,
      old_lines: oldLines.length,
      new_lines: newLines.length
    });

    const parsed = parseChangedLines(pair, oldLines, newLines);
    removed.push(...parsed.removed);
    added.push(...parsed.added);
  }

  const paired = pairExactLines(removed, added);
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
  const blocks = drafts.map((draft, index) => buildBlock(`move-${index + 1}`, draft, renderContext));
  const rendered = blocks.filter((block) => block.blockpatch.status === "rendered").length;

  return {
    commit: info.commit,
    parent: info.parent,
    repo: info.repo,
    files: fileDigests,
    blocks,
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
}

function parseChangedLines(pair: FilePair, oldLines: LineRecord[], newLines: LineRecord[]): ParsedChanges {
  const removed: RemovedLine[] = [];
  const added: AddedLine[] = [];
  const lines = pair.diff.split("\n");
  let oldCursor = 0;
  let newCursor = 0;
  let inHunk = false;

  for (const raw of lines) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
    if (hunk !== null) {
      inHunk = true;
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

  return { removed, added };
}

function pairExactLines(removed: RemovedLine[], added: AddedLine[]): PairedLine[] {
  const byKey = new Map<string, RemovedLine[]>();
  const paired: PairedLine[] = [];

  for (const line of removed) {
    const bucket = byKey.get(line.line.key);
    if (bucket === undefined) {
      byKey.set(line.line.key, [line]);
    } else {
      bucket.push(line);
    }
  }

  for (const dst of added) {
    const bucket = byKey.get(dst.line.key);
    const src = bucket?.shift();
    if (src === undefined) {
      continue;
    }
    src.paired = dst;
    dst.paired = src;
    paired.push({ src, dst });
  }

  return paired;
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

function buildBlock(id: string, draft: BlockDraft, context: RenderContext): LineMoveBlock {
  const srcLines = draft.srcLines;
  const dstLines = draft.dstLines;
  const payload = srcLines !== null ? concatLineBytes(srcLines) : concatLineBytes(dstLines ?? []);
  const hash = createHash("sha256").update(payload).digest("hex");
  const blockpatch = safeRenderBlockPatch({
    id,
    srcLines,
    dstLines,
    payload,
    targetInsertBeforeLine: draft.targetInsertBeforeLine
  }, context);

  return {
    id,
    kind: srcLines !== null && dstLines !== null ? "move" : srcLines === null ? "insert" : "delete",
    src: srcLines === null ? null : spanForLines(srcLines),
    dst: dstLines === null ? null : spanForLines(dstLines),
    payload_sha256: hash,
    payload_bytes: payload.length,
    payload_lines: srcLines?.length ?? dstLines?.length ?? 0,
    payload: decodeUtf8(payload),
    blockpatch
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

function decodeUtf8(bytes: Buffer): string {
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    return bytes.toString("base64");
  }
}
