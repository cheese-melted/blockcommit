import { type BlockCommitDigest } from "./types";

// Pairwise file-identity flow view over the digest. Each line aggregates
// cross-path move blocks as source old total -> destination new total (moved).
export function renderIdentity(digest: BlockCommitDigest): string {
  const lines = identityFlows(digest).map(
    (flow) => `${quotePath(flow.srcPath)}:${flow.srcLines} -> ${quotePath(flow.dstPath)}:${flow.dstLines} (${flow.movedLines})`
  );
  return lines.length === 0 ? "" : lines.join("\n") + "\n";
}

export function renderIdentityFrom(digest: BlockCommitDigest): string {
  const lines = renderIdentitySources(identityFlows(digest));
  return lines.length === 0 ? "" : lines.join("\n") + "\n";
}

export function renderIdentityTo(digest: BlockCommitDigest): string {
  const lines = renderIdentityDestinations(identityFlows(digest));
  return lines.length === 0 ? "" : lines.join("\n") + "\n";
}

export interface IdentityFlow {
  srcPath: string;
  dstPath: string;
  srcLines: number;
  dstLines: number;
  movedLines: number;
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

function renderIdentitySources(flows: IdentityFlow[]): string[] {
  const flowsBySrc = groupBy(flows, (flow) => flow.srcPath);
  const lines: string[] = [];
  for (const srcPath of [...flowsBySrc.keys()].sort()) {
    const srcFlows = (flowsBySrc.get(srcPath) ?? []).sort((left, right) =>
      right.movedLines - left.movedLines ||
      left.dstPath.localeCompare(right.dstPath)
    );
    const srcLines = srcFlows[0]?.srcLines ?? 0;
    const parts = srcFlows.map((flow) =>
      `${quotePath(flow.dstPath)} ${formatPercent(flow.movedLines / srcLines)} (${flow.movedLines}/${srcLines})`
    );
    const movedLines = srcFlows.reduce((sum, flow) => sum + flow.movedLines, 0);
    const unmovedLines = Math.max(0, srcLines - movedLines);
    if (unmovedLines > 0) {
      parts.push(`unmoved ${formatPercent(unmovedLines / srcLines)} (${unmovedLines}/${srcLines})`);
    }
    lines.push(`from ${quotePath(srcPath)}:${srcLines} => ${parts.join(", ")}`);
  }
  return lines;
}

function renderIdentityDestinations(flows: IdentityFlow[]): string[] {
  const flowsByDst = groupBy(flows, (flow) => flow.dstPath);
  const lines: string[] = [];
  for (const dstPath of [...flowsByDst.keys()].sort()) {
    const dstFlows = (flowsByDst.get(dstPath) ?? []).sort((left, right) =>
      right.movedLines - left.movedLines ||
      left.srcPath.localeCompare(right.srcPath)
    );
    const dstLines = dstFlows[0]?.dstLines ?? 0;
    const parts = dstFlows.map((flow) =>
      `${quotePath(flow.srcPath)} ${formatPercent(flow.movedLines / dstLines)} (${flow.movedLines}/${dstLines})`
    );
    const movedLines = dstFlows.reduce((sum, flow) => sum + flow.movedLines, 0);
    const newLines = Math.max(0, dstLines - movedLines);
    if (newLines > 0) {
      parts.push(`new ${formatPercent(newLines / dstLines)} (${newLines}/${dstLines})`);
    }
    lines.push(`to ${quotePath(dstPath)}:${dstLines} <= ${parts.join(", ")}`);
  }
  return lines;
}

function groupBy<T>(values: T[], keyFor: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const key = keyFor(value);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [value]);
    } else {
      group.push(value);
    }
  }
  return groups;
}

function formatPercent(value: number): string {
  const percent = value * 100;
  const rounded = Math.round(percent * 10) / 10;
  if (value > 0 && rounded === 0) {
    return "<0.1%";
  }
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}

function quotePath(path: string): string {
  return /[\s"\\\u0000-\u001f]/.test(path) ? JSON.stringify(path) : path;
}
