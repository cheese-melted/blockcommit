import { type BlockCommitDigest } from "./types";

export const couplingSchemaVersion = "blockcommit.coupling.v1";

export type CouplingOp =
  | ["move", string, string, number, number, number]
  | ["insert", null, string, number, 0, number]
  | ["delete", string, null, number, number, 0];

export interface CouplingPayload {
  schema_version: typeof couplingSchemaVersion;
  commit: string;
  parent: string | null;
  symbols: Record<string, string>;
  ops: CouplingOp[];
}

type EndpointSide = "old" | "new";

export function couplingPayload(digest: BlockCommitDigest): CouplingPayload {
  const builder = new SymbolBuilder(digest);
  const ops: CouplingOp[] = [];

  for (const block of digest.blocks) {
    if (block.kind === "move") {
      const fromSymbol = builder.symbolFor("old", block.src.path);
      const toSymbol = builder.symbolFor("new", block.dst.path);
      ops.push([
        "move",
        fromSymbol,
        toSymbol,
        block.payload_lines,
        builder.oldLineCount(block.src.path),
        builder.newLineCount(block.dst.path)
      ]);
      continue;
    }
    if (block.kind === "insert") {
      const toSymbol = builder.symbolFor("new", block.dst.path);
      ops.push(["insert", null, toSymbol, block.payload_lines, 0, builder.newLineCount(block.dst.path)]);
      continue;
    }

    const fromSymbol = builder.symbolFor("old", block.src.path);
    ops.push(["delete", fromSymbol, null, block.payload_lines, builder.oldLineCount(block.src.path), 0]);
  }

  return {
    schema_version: couplingSchemaVersion,
    commit: digest.commit,
    parent: digest.parent,
    symbols: builder.symbols,
    ops
  };
}

class SymbolBuilder {
  readonly symbols: Record<string, string> = {};
  private readonly filesByPath: Map<string, { old_lines: number; new_lines: number; old_exists: boolean; new_exists: boolean }>;
  private readonly reusedPaths: Set<string>;
  private readonly symbolByKey = new Map<string, string>();

  constructor(digest: BlockCommitDigest) {
    this.filesByPath = new Map(digest.files.map((file) => [file.path, file]));
    this.reusedPaths = new Set(
      digest.identity
        .filter((event) => event.kind === "path_reused")
        .map((event) => event.old_identity.path)
    );
  }

  symbolFor(side: EndpointSide, path: string): string {
    const key = this.endpointKey(side, path);
    const existing = this.symbolByKey.get(key);
    if (existing !== undefined) {
      return existing;
    }

    const symbol = `s${this.symbolByKey.size + 1}`;
    this.symbolByKey.set(key, symbol);
    this.symbols[symbol] = path;
    return symbol;
  }

  oldLineCount(path: string): number {
    return this.filesByPath.get(path)?.old_lines ?? 0;
  }

  newLineCount(path: string): number {
    return this.filesByPath.get(path)?.new_lines ?? 0;
  }

  private endpointKey(side: EndpointSide, path: string): string {
    const file = this.filesByPath.get(path);
    if (side === "old") {
      return file?.new_exists === false || this.reusedPaths.has(path) ? `old:${path}` : `path:${path}`;
    }
    return file?.old_exists === false || this.reusedPaths.has(path) ? `new:${path}` : `path:${path}`;
  }
}
