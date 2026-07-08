import { nullPath, type BlockCommitDigest, type LineMoveBlock, type LineSpan } from "./types";

// Compact content view over the digest: one line per block. src coordinates
// are parent-image, dst coordinates are post-image, and path:start+count means
// start at that line and include count lines. A display format; the JSON
// digest stays canonical.
export function renderContent(digest: BlockCommitDigest): string {
  const lines = digest.blocks.map((block) => renderBlockOp(block));
  return lines.length === 0 ? "" : lines.join("\n") + "\n";
}

function renderBlockOp(block: LineMoveBlock): string {
  if (block.kind === "insert") {
    return `+ ${spanRef(block.dst)}`;
  }
  if (block.kind === "delete") {
    return `- ${spanRef(block.src)}`;
  }
  return `M ${spanRef(block.src)} -> ${spanRef(block.dst)}`;
}

function spanRef(span: LineSpan | null): string {
  if (span === null) {
    return nullPath;
  }
  return `${quotePath(span.path)}:${span.start_line}+${span.line_count}`;
}

function quotePath(path: string): string {
  return /[\s"\\\u0000-\u001f]/.test(path) ? JSON.stringify(path) : path;
}
