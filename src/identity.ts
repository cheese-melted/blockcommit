import {
  type ChangedFileDigest,
  type IdentityEvent,
  type LineMoveBlock
} from "./types.js";

interface DestinationAggregate {
  path: string;
  lines: number;
  blocks: string[];
}

// Derives file-identity events from the block digest. This is a view, not
// new data: it names what the move blocks already imply about file
// continuity, so consumers don't have to re-infer it.
//
// An event is emitted when a strict majority of a file's parent-image lines
// moved to a single other path:
//   renamed     — the old path no longer exists after the commit
//   path_reused — the old path still exists, but its previous identity left
//                 and different content now occupies the name
//
// confidence is "exact" only when every old line of the file moved to the
// destination and every line of the destination's post-image came from it;
// anything looser is "partial".
export function deriveIdentity(files: ChangedFileDigest[], blocks: LineMoveBlock[]): IdentityEvent[] {
  const destinationsBySrc = new Map<string, Map<string, DestinationAggregate>>();
  for (const block of blocks) {
    if (block.kind !== "move" || block.src === null || block.dst === null) {
      continue;
    }
    if (block.src.path === block.dst.path) {
      continue;
    }
    let destinations = destinationsBySrc.get(block.src.path);
    if (destinations === undefined) {
      destinations = new Map();
      destinationsBySrc.set(block.src.path, destinations);
    }
    let aggregate = destinations.get(block.dst.path);
    if (aggregate === undefined) {
      aggregate = { path: block.dst.path, lines: 0, blocks: [] };
      destinations.set(block.dst.path, aggregate);
    }
    aggregate.lines += block.src.line_count;
    aggregate.blocks.push(block.id);
  }

  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const events: IdentityEvent[] = [];

  for (const file of files) {
    if (!file.old_exists || file.old_lines === 0) {
      continue;
    }
    const destinations = destinationsBySrc.get(file.path);
    if (destinations === undefined) {
      continue;
    }

    let dominant: DestinationAggregate | null = null;
    for (const aggregate of destinations.values()) {
      if (dominant === null || aggregate.lines > dominant.lines) {
        dominant = aggregate;
      }
    }
    if (dominant === null || dominant.lines * 2 <= file.old_lines) {
      continue;
    }

    const destination = filesByPath.get(dominant.path);
    const destinationLines = destination?.new_lines ?? 0;
    const exact = dominant.lines === file.old_lines && dominant.lines === destinationLines;

    events.push({
      kind: file.new_exists ? "path_reused" : "renamed",
      old_identity: {
        path: file.path,
        lines: file.old_lines,
        sha256: file.old_sha256
      },
      moved_to: {
        path: dominant.path,
        lines_moved: dominant.lines,
        blocks: dominant.blocks
      },
      new_identity: file.new_exists
        ? { path: file.path, lines: file.new_lines, sha256: file.new_sha256 }
        : null,
      confidence: exact ? "exact" : "partial"
    });
  }

  return events;
}
