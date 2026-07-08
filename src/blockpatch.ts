import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import {
  countLineBytes,
  lineAfterInsertion,
  lineBeforeInsertion,
  nextLine,
  previousLine,
  type LineRecord
} from "./lines";
import { nullPath } from "./types";

export type BlockPatchStatus = "rendered" | "unsupported";

export interface BlockPatchRendering {
  status: BlockPatchStatus;
  reason?: string;
}

export interface RenderableBlock {
  id: string;
  srcLines: LineRecord[] | null;
  dstLines: LineRecord[] | null;
  payload: Buffer;
  targetInsertBeforeLine?: number;
}

interface HunkNumbers {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

export interface RenderContext {
  oldLinesByPath: Map<string, LineRecord[]>;
  oldExists: Set<string>;
  newExists: Set<string>;
  removedLineIds: Set<string>;
}

export interface BlockPatchRenderResult extends BlockPatchRendering {
  patch?: string;
}

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export function renderBlockPatch(block: RenderableBlock, context: RenderContext): BlockPatchRenderResult {
  const srcPath = block.srcLines?.[0]?.path;
  const dstPath = block.dstLines?.[0]?.path;
  const payloadSha = createHash("sha256").update(block.payload).digest("hex");

  if (srcPath !== undefined && dstPath !== undefined) {
    if (!context.oldExists.has(dstPath)) {
      return unsupported("destination path does not exist before the commit");
    }
    const sourceLines = context.oldLinesByPath.get(srcPath) ?? [];
    const targetLines = context.oldLinesByPath.get(dstPath) ?? [];
    const sourceBefore = previousLine(sourceLines, block.srcLines![0].lineNo);
    const sourceAfter = nextLine(sourceLines, block.srcLines![block.srcLines!.length - 1].lineNo);
    const targetBefore = lineBeforeInsertion(targetLines, block.targetInsertBeforeLine ?? 1);
    const targetAfter = lineAfterInsertion(targetLines, block.targetInsertBeforeLine ?? 1);

    if (targetBefore.length === 0 && targetAfter.length === 0) {
      return unsupported("target insertion has no pre-existing anchor");
    }
    if (targetAnchorRemoved(dstPath, block.targetInsertBeforeLine ?? 1, targetBefore, targetAfter, context)) {
      return unsupported("target anchor is removed by the same commit");
    }

    return rendered(
      srcPath === dstPath
        ? renderSameFileMove(
            block.id,
            srcPath,
            sourceHunkNumbers(block.srcLines!, sourceBefore, block.payload, sourceAfter),
            sourceBefore,
            block.payload,
            sourceAfter,
            targetHunkNumbers(block.targetInsertBeforeLine ?? 1, targetBefore, block.payload, targetAfter),
            targetBefore,
            targetAfter,
            payloadSha
          )
        : renderCrossFileMove(
            block.id,
            srcPath,
            dstPath,
            sourceHunkNumbers(block.srcLines!, sourceBefore, block.payload, sourceAfter),
            sourceBefore,
            block.payload,
            sourceAfter,
            targetHunkNumbers(block.targetInsertBeforeLine ?? 1, targetBefore, block.payload, targetAfter),
            targetBefore,
            targetAfter,
            payloadSha
          )
    );
  }

  if (srcPath === undefined && dstPath !== undefined) {
    const targetLines = context.oldLinesByPath.get(dstPath) ?? [];
    const targetBefore = lineBeforeInsertion(targetLines, block.targetInsertBeforeLine ?? 1);
    const targetAfter = lineAfterInsertion(targetLines, block.targetInsertBeforeLine ?? 1);

    if (!context.oldExists.has(dstPath)) {
      return rendered(renderPathCreation(block.id, dstPath, block.payload, payloadSha));
    }
    if (targetBefore.length === 0 && targetAfter.length === 0) {
      return unsupported("target insertion has no pre-existing anchor");
    }
    if (targetAnchorRemoved(dstPath, block.targetInsertBeforeLine ?? 1, targetBefore, targetAfter, context)) {
      return unsupported("target anchor is removed by the same commit");
    }
    return rendered(
      renderInsertion(
        block.id,
        dstPath,
        block.payload,
        targetHunkNumbers(block.targetInsertBeforeLine ?? 1, targetBefore, block.payload, targetAfter),
        targetBefore,
        targetAfter,
        payloadSha
      )
    );
  }

  if (srcPath !== undefined && dstPath === undefined) {
    const sourceLines = context.oldLinesByPath.get(srcPath) ?? [];
    const sourceBefore = previousLine(sourceLines, block.srcLines![0].lineNo);
    const sourceAfter = nextLine(sourceLines, block.srcLines![block.srcLines!.length - 1].lineNo);
    const removesWholePath =
      !context.newExists.has(srcPath) &&
      block.srcLines?.length === sourceLines.length &&
      block.srcLines[0]?.lineNo === 1;

    if (removesWholePath) {
      return rendered(renderPathDeletion(block.id, srcPath, block.payload, payloadSha));
    }
    return rendered(
      renderDeletion(
        block.id,
        srcPath,
        block.payload,
        sourceHunkNumbers(block.srcLines!, sourceBefore, block.payload, sourceAfter),
        sourceBefore,
        sourceAfter,
        payloadSha
      )
    );
  }

  return unsupported("block has no source or destination");
}

function rendered(patch: string): BlockPatchRenderResult {
  return { status: "rendered", patch };
}

function unsupported(reason: string): BlockPatchRenderResult {
  return { status: "unsupported", reason };
}

function renderSameFileMove(
  id: string,
  path: string,
  sourceNumbers: HunkNumbers,
  sourceBefore: Buffer,
  payload: Buffer,
  sourceAfter: Buffer,
  targetNumbers: HunkNumbers,
  targetBefore: Buffer,
  targetAfter: Buffer,
  payloadSha: string
): string {
  return [
    `diff --blockpatch a/${path} b/${path}`,
    "blockpatch version 1",
    `blockpatch move id=${id} payload-sha256=${payloadSha}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "",
    hunkHeader("source", id, sourceNumbers),
    hunkBody(sourceBefore, payload, sourceAfter, "-"),
    hunkHeader("target", id, targetNumbers),
    hunkBody(targetBefore, payload, targetAfter, "+")
  ].join("\n") + "\n";
}

function renderCrossFileMove(
  id: string,
  srcPath: string,
  dstPath: string,
  sourceNumbers: HunkNumbers,
  sourceBefore: Buffer,
  payload: Buffer,
  sourceAfter: Buffer,
  targetNumbers: HunkNumbers,
  targetBefore: Buffer,
  targetAfter: Buffer,
  payloadSha: string
): string {
  return [
    `diff --blockpatch a/${srcPath} b/${srcPath}`,
    "blockpatch version 1",
    `blockpatch move id=${id} role=source payload-sha256=${payloadSha}`,
    `--- a/${srcPath}`,
    `+++ b/${srcPath}`,
    "",
    hunkHeader("source", id, sourceNumbers),
    hunkBody(sourceBefore, payload, sourceAfter, "-"),
    "",
    `diff --blockpatch a/${dstPath} b/${dstPath}`,
    "blockpatch version 1",
    `blockpatch move id=${id} role=target payload-sha256=${payloadSha}`,
    `--- a/${dstPath}`,
    `+++ b/${dstPath}`,
    "",
    hunkHeader("target", id, targetNumbers),
    hunkBody(targetBefore, payload, targetAfter, "+")
  ].join("\n") + "\n";
}

function renderInsertion(
  id: string,
  path: string,
  payload: Buffer,
  targetNumbers: HunkNumbers,
  targetBefore: Buffer,
  targetAfter: Buffer,
  payloadSha: string
): string {
  return [
    `diff --blockpatch a/${path} b/${path}`,
    "blockpatch version 1",
    `blockpatch move id=${id} payload-sha256=${payloadSha}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "",
    hunkHeader("target", id, targetNumbers),
    hunkBody(targetBefore, payload, targetAfter, "+")
  ].join("\n") + "\n";
}

function renderDeletion(
  id: string,
  path: string,
  payload: Buffer,
  sourceNumbers: HunkNumbers,
  sourceBefore: Buffer,
  sourceAfter: Buffer,
  payloadSha: string
): string {
  return [
    `diff --blockpatch a/${path} b/${path}`,
    "blockpatch version 1",
    `blockpatch move id=${id} payload-sha256=${payloadSha}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "",
    hunkHeader("source", id, sourceNumbers),
    hunkBody(sourceBefore, payload, sourceAfter, "-")
  ].join("\n") + "\n";
}

function renderPathCreation(id: string, path: string, payload: Buffer, payloadSha: string): string {
  return [
    `diff --blockpatch ${nullPath} b/${path}`,
    "blockpatch version 1",
    `blockpatch move id=${id} payload-sha256=${payloadSha}`,
    `--- ${nullPath}`,
    `+++ b/${path}`,
    "",
    hunkHeader("target", id, {
      oldStart: 0,
      oldCount: 0,
      newStart: payload.length === 0 ? 0 : 1,
      newCount: countLineBytes(payload)
    }),
    hunkBody(Buffer.alloc(0), payload, Buffer.alloc(0), "+")
  ].join("\n") + "\n";
}

function renderPathDeletion(id: string, path: string, payload: Buffer, payloadSha: string): string {
  return [
    `diff --blockpatch a/${path} ${nullPath}`,
    "blockpatch version 1",
    `blockpatch move id=${id} payload-sha256=${payloadSha}`,
    `--- a/${path}`,
    `+++ ${nullPath}`,
    "",
    hunkHeader("source", id, {
      oldStart: payload.length === 0 ? 0 : 1,
      oldCount: countLineBytes(payload),
      newStart: 0,
      newCount: 0
    }),
    hunkBody(Buffer.alloc(0), payload, Buffer.alloc(0), "-")
  ].join("\n") + "\n";
}

function sourceHunkNumbers(
  sourceLines: LineRecord[],
  before: Buffer,
  payload: Buffer,
  after: Buffer
): HunkNumbers {
  const beforeLines = countLineBytes(before);
  const oldStart = Math.max(1, sourceLines[0].lineNo - beforeLines);
  return {
    oldStart,
    oldCount: beforeLines + countLineBytes(payload) + countLineBytes(after),
    newStart: oldStart,
    newCount: beforeLines + countLineBytes(after)
  };
}

function targetHunkNumbers(insertBeforeLine: number, before: Buffer, payload: Buffer, after: Buffer): HunkNumbers {
  const beforeLines = countLineBytes(before);
  const afterLines = countLineBytes(after);
  const oldStart = beforeLines > 0 ? insertBeforeLine - beforeLines : insertBeforeLine;
  return {
    oldStart,
    oldCount: beforeLines + afterLines,
    newStart: oldStart,
    newCount: beforeLines + countLineBytes(payload) + afterLines
  };
}

function targetAnchorRemoved(
  path: string,
  insertBeforeLine: number,
  before: Buffer,
  after: Buffer,
  context: RenderContext
): boolean {
  const beforeRemoved = before.length > 0 && context.removedLineIds.has(lineId(path, insertBeforeLine - 1));
  const afterRemoved = after.length > 0 && context.removedLineIds.has(lineId(path, insertBeforeLine));
  return beforeRemoved || afterRemoved;
}

export function lineId(path: string, lineNo: number): string {
  return `${path}\0${lineNo}`;
}

function hunkHeader(kind: "source" | "target", id: string, numbers: HunkNumbers): string {
  return `@@ -${numbers.oldStart},${numbers.oldCount} +${numbers.newStart},${numbers.newCount} @@ blockpatch-${kind} id=${id}`;
}

function hunkBody(before: Buffer, payload: Buffer, after: Buffer, payloadPrefix: "-" | "+"): string {
  return [
    renderHunkBytes(before, " "),
    renderHunkBytes(payload, payloadPrefix),
    renderHunkBytes(after, " ")
  ].filter((chunk) => chunk.length > 0).join("\n");
}

function renderHunkBytes(bytes: Buffer, prefix: " " | "-" | "+"): string {
  const text = decodeUtf8(bytes);
  if (text.length === 0) {
    return "";
  }

  return text
    .split(/(?<=\n)/)
    .filter((line) => line.length > 0)
    .map((line) => {
      if (line.endsWith("\n")) {
        return `${prefix}${line.slice(0, -1)}`;
      }
      return `${prefix}${line}\n\\ No newline at end of file`;
    })
    .join("\n");
}

function decodeUtf8(bytes: Buffer): string {
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    throw new Error("blockpatch rendering requires valid UTF-8 payloads and anchors");
  }
}

export function renderedPayloadLineCount(payload: Buffer): number {
  return countLineBytes(payload);
}
