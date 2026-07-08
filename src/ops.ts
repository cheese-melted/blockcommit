import { nullPath, type BlockCommitDigest, type IdentityEvent, type LineMoveBlock, type LineSpan } from "./types";

// Compact content view over the digest: one line per block. src coordinates
// are parent-image, dst coordinates are post-image, and path:start+count means
// start at that line and include count lines. A display format — the JSON
// digest stays canonical.
//
//   M old.ts:5+8 -> new.ts:1+8
//   + README.md:12+2
//   - src/dead.ts:1+20
export function renderOps(digest: BlockCommitDigest): string {
  const lines = digest.blocks.map((block) => renderBlockOp(block));
  return lines.length === 0 ? "" : lines.join("\n") + "\n";
}

// Tight file-identity view over the digest. It only names exact file-level
// continuity events; partial continuity remains visible as ordinary block ops.
export function renderIdentity(digest: BlockCommitDigest): string {
  const lines = digest.identity
    .filter((event) => event.confidence === "exact")
    .map((event) => renderIdentityOp(event));
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

function renderIdentityOp(event: IdentityEvent): string {
  const kind = event.kind === "path_reused" ? "reuse" : "rename";
  return `${kind} ${quotePath(event.old_identity.path)} -> ${quotePath(event.moved_to.path)}`;
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
