import { type BlockCommitDigest } from "./types";

export const couplingSchemaVersion = "blockcommit.coupling.v1";

export type CouplingOp =
  | ["move", number, number, number, number, number]
  | ["insert", null, number, number, 0, number]
  | ["delete", number, null, number, number, 0];

export interface CouplingPayload {
  schema_version: typeof couplingSchemaVersion;
  commit: string;
  parent: string | null;
  symbols: string[];
  ops: CouplingOp[];
}

export function couplingPayload(digest: BlockCommitDigest): CouplingPayload {
  const ops: CouplingOp[] = [];

  for (const block of digest.blocks) {
    if (block.kind === "move") {
      ops.push([
        "move",
        block.src.symbol,
        block.dst.symbol,
        block.payload_lines,
        block.src.total_lines,
        block.dst.total_lines
      ]);
      continue;
    }
    if (block.kind === "insert") {
      ops.push(["insert", null, block.dst.symbol, block.payload_lines, 0, block.dst.total_lines]);
      continue;
    }

    ops.push(["delete", block.src.symbol, null, block.payload_lines, block.src.total_lines, 0]);
  }

  return {
    schema_version: couplingSchemaVersion,
    commit: digest.commit,
    parent: digest.parent,
    symbols: digest.symbols,
    ops
  };
}
