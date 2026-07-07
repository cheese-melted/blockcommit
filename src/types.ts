export const nullPath = "/dev/null";
export const schemaVersion = "blockcommit.digest.v1";

export type BlockKind = "move" | "insert" | "delete";
export type BlockPatchStatus = "rendered" | "unsupported";
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

export interface BlockPatchRendering {
  status: BlockPatchStatus;
  patch?: string;
  reason?: string;
}

export interface MatchMetadata {
  algorithm: "exact-line-sha256-patience";
  ambiguous: boolean;
  duplicate_removed_candidates: number;
  duplicate_added_candidates: number;
}

export interface LineMoveBlock {
  id: string;
  kind: BlockKind;
  src: LineSpan | null;
  dst: LineSpan | null;
  payload_sha256: string;
  payload_bytes: number;
  payload_lines: number;
  payload_encoding: PayloadEncoding;
  payload_text?: string;
  payload_base64?: string;
  match: MatchMetadata;
  blockpatch: BlockPatchRendering;
}

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
  rendered_blockpatches: number;
  unsupported_blockpatches: number;
}

export interface BlockCommitDigest {
  schema_version: typeof schemaVersion;
  commit: string;
  parent: string | null;
  repo: string;
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
