import { nullPath, type BlockCommitDigest, type IdentityEvent, type LineMoveBlock, type LineSpan } from "./types";

const kindLetters = { move: "M", insert: "I", delete: "D" } as const;

// Compact movement view over the digest: one line per block, src and dst as
// path:start+count in parent-image and post-image coordinates respectively,
// followed by one line per derived identity event. A display format — the
// JSON digest stays canonical.
//
//   M old.ts:5+8 -> new.ts:1+8 sha=def456abc123
//   I /dev/null -> README.md:12+2 sha=789abcdef012
//   D src/dead.ts:1+20 -> /dev/null sha=456def789abc
//   identity renamed old.ts -> new.ts moved=8/8 exact
export function renderOps(digest: BlockCommitDigest): string {
  const lines = [
    ...digest.blocks.map((block) => renderBlockOp(block)),
    ...digest.identity.map((event) => renderIdentityOp(event))
  ];
  return lines.length === 0 ? "" : lines.join("\n") + "\n";
}

function renderBlockOp(block: LineMoveBlock): string {
  return `${kindLetters[block.kind]} ${spanRef(block.src)} -> ${spanRef(block.dst)} sha=${block.payload_sha256.slice(0, 12)}`;
}

function renderIdentityOp(event: IdentityEvent): string {
  const parts = [
    "identity",
    event.kind,
    quotePath(event.old_identity.path),
    "->",
    quotePath(event.moved_to.path),
    `moved=${event.moved_to.lines_moved}/${event.old_identity.lines}`
  ];
  if (event.new_identity !== null) {
    parts.push(`new_lines=${event.new_identity.lines}`);
  }
  parts.push(event.confidence);
  return parts.join(" ");
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
