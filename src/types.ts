export const nullPath = "/dev/null";
export const schemaVersion = "blockcommit.digest.v2";
export const digestAlgorithm = {
  name: "exact-line-sha256-identity-preserving",
  version: 2,
  anchor_min_alnum: 4,
  exact_block_fallback: true,
  whole_file_identity: true,
  git_diff: {
    algorithm: "myers",
    indent_heuristic: false
  }
} as const;

export type BlockKind = "move" | "insert" | "delete";
export type PayloadEncoding = "utf-8" | "base64";
export type LineDigestStatus = "represented" | "partial" | "unsupported";
export type UnsupportedReason = "binary" | "mode_only" | "submodule" | "filetype" | "unparsed_diff";

export interface LineSpan {
  path: string;
  start_line: number;
  end_line: number;
  line_count: number;
  byte_start: number;
  byte_end: number;
}

export type DigestAlgorithm = typeof digestAlgorithm;

interface BaseLineMoveBlock {
  id: string;
  payload_sha256: string;
  payload_bytes: number;
  payload_lines: number;
  payload_encoding: PayloadEncoding;
  payload_text?: string;
  payload_base64?: string;
}

export interface MoveBlock extends BaseLineMoveBlock {
  kind: "move";
  src: LineSpan;
  dst: LineSpan;
}

export interface InsertBlock extends BaseLineMoveBlock {
  kind: "insert";
  src: null;
  dst: LineSpan;
}

export interface DeleteBlock extends BaseLineMoveBlock {
  kind: "delete";
  src: LineSpan;
  dst: null;
}

export type LineMoveBlock = MoveBlock | InsertBlock | DeleteBlock;

export interface ChangedFileDigest {
  path: string;
  old_exists: boolean;
  new_exists: boolean;
  old_mode: string | null;
  new_mode: string | null;
  old_oid: string | null;
  new_oid: string | null;
  binary: boolean;
  old_lines: number;
  new_lines: number;
  old_sha256: string | null;
  new_sha256: string | null;
  line_digest_status: LineDigestStatus;
  unsupported_reason?: UnsupportedReason;
}

export type IdentityKind = "renamed" | "path_reused";
export type IdentityConfidence = "exact" | "partial";

export interface IdentityEndpoint {
  path: string;
  lines: number;
  sha256: string | null;
}

export interface IdentityMove {
  path: string;
  lines_moved: number;
  blocks: string[];
}

export interface IdentityCoverage {
  old_file_lines_moved: number;
  new_file_lines_from_old: number;
}

export interface IdentityEvent {
  kind: IdentityKind;
  old_identity: IdentityEndpoint;
  moved_to: IdentityMove;
  new_identity: IdentityEndpoint | null;
  confidence: IdentityConfidence;
  coverage: IdentityCoverage;
}

export interface BlockCommitSummary {
  files: number;
  blocks: number;
  moves: number;
  insertions: number;
  deletions: number;
}

export interface BlockCommitDigest {
  schema_version: typeof schemaVersion;
  algorithm: DigestAlgorithm;
  commit: string;
  parent: string | null;
  files: ChangedFileDigest[];
  blocks: LineMoveBlock[];
  identity: IdentityEvent[];
  summary: BlockCommitSummary;
}

export interface FileVerification {
  path: string;
  ok: boolean;
  reason?: string;
}

export interface VerifyResult {
  commit: string;
  ok: boolean;
  files: FileVerification[];
}
