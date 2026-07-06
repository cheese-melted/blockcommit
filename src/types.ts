export const nullPath = "/dev/null";

export type BlockKind = "move" | "insert" | "delete";
export type BlockPatchStatus = "rendered" | "unsupported";

export interface LineSpan {
  path: string;
  start_line: number;
  end_line: number;
  byte_start: number;
  byte_end: number;
}

export interface BlockPatchRendering {
  status: BlockPatchStatus;
  patch?: string;
  reason?: string;
}

export interface LineMoveBlock {
  id: string;
  kind: BlockKind;
  src: LineSpan | null;
  dst: LineSpan | null;
  payload_sha256: string;
  payload_bytes: number;
  payload_lines: number;
  payload: string;
  blockpatch: BlockPatchRendering;
}

export interface ChangedFileDigest {
  path: string;
  old_exists: boolean;
  new_exists: boolean;
  old_lines: number;
  new_lines: number;
}

export interface BlockCommitSummary {
  files: number;
  blocks: number;
  moves: number;
  insertions: number;
  deletions: number;
  rendered_blockpatches: number;
  unsupported_blockpatches: number;
}

export interface BlockCommitDigest {
  commit: string;
  parent: string | null;
  repo: string;
  files: ChangedFileDigest[];
  blocks: LineMoveBlock[];
  summary: BlockCommitSummary;
}
