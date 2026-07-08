import { nullPath, type BlockCommitDigest, type LineMoveBlock, type LineSpan } from "./types";

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

// Pairwise file-identity flow view over the digest. Each line aggregates
// cross-path move blocks as source old total -> destination new total (moved).
export function renderIdentity(digest: BlockCommitDigest): string {
  const lines = identityFlows(digest).map(
    (flow) => `${quotePath(flow.srcPath)}:${flow.srcLines} -> ${quotePath(flow.dstPath)}:${flow.dstLines} (${flow.movedLines})`
  );
  return lines.length === 0 ? "" : lines.join("\n") + "\n";
}

export function renderIdentitySummary(digest: BlockCommitDigest): string {
  const flows = identityFlows(digest);
  const outgoing = countBy(flows, (flow) => flow.srcPath);
  const incoming = countBy(flows, (flow) => flow.dstPath);
  const filesByPath = new Map(digest.files.map((file) => [file.path, file]));
  const lines = flows.map((flow) => {
    const srcPct = flow.movedLines / flow.srcLines;
    const dstPct = flow.movedLines / flow.dstLines;
    const label = identitySummaryLabel(flow, filesByPath, outgoing, incoming);
    return `${label} ${quotePath(flow.srcPath)} -> ${quotePath(flow.dstPath)} src=${formatPercent(srcPct)} dst=${formatPercent(dstPct)} (${flow.movedLines}/${flow.srcLines} -> ${flow.movedLines}/${flow.dstLines})`;
  });
  return lines.length === 0 ? "" : lines.join("\n") + "\n";
}

export interface IdentityFlow {
  srcPath: string;
  dstPath: string;
  srcLines: number;
  dstLines: number;
  movedLines: number;
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

export function identityFlows(digest: BlockCommitDigest): IdentityFlow[] {
  const filesByPath = new Map(digest.files.map((file) => [file.path, file]));
  const flows = new Map<string, IdentityFlow>();

  for (const block of digest.blocks) {
    if (block.kind !== "move" || block.src.path === block.dst.path) {
      continue;
    }
    const key = `${block.src.path}\0${block.dst.path}`;
    const existing = flows.get(key);
    if (existing !== undefined) {
      existing.movedLines += block.src.line_count;
      continue;
    }
    flows.set(key, {
      srcPath: block.src.path,
      dstPath: block.dst.path,
      srcLines: filesByPath.get(block.src.path)?.old_lines ?? block.src.line_count,
      dstLines: filesByPath.get(block.dst.path)?.new_lines ?? block.dst.line_count,
      movedLines: block.src.line_count
    });
  }

  return [...flows.values()].sort((left, right) =>
    left.srcPath.localeCompare(right.srcPath) ||
    left.dstPath.localeCompare(right.dstPath)
  );
}

function identitySummaryLabel(
  flow: IdentityFlow,
  filesByPath: Map<string, BlockCommitDigest["files"][number]>,
  outgoing: Map<string, number>,
  incoming: Map<string, number>
): string {
  const srcComplete = flow.movedLines === flow.srcLines;
  const dstComplete = flow.movedLines === flow.dstLines;
  if ((outgoing.get(flow.srcPath) ?? 0) > 1) {
    return (incoming.get(flow.dstPath) ?? 0) > 1 ? "split+merge" : "split";
  }
  if ((incoming.get(flow.dstPath) ?? 0) > 1) {
    return "merge";
  }
  if (srcComplete && dstComplete) {
    return filesByPath.get(flow.srcPath)?.new_exists === true ? "reuse" : "rename";
  }
  return "flow";
}

function countBy<T>(values: T[], keyFor: (value: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const key = keyFor(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function formatPercent(value: number): string {
  const percent = value * 100;
  const rounded = Math.round(percent * 10) / 10;
  if (value > 0 && rounded === 0) {
    return "<0.1%";
  }
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
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
