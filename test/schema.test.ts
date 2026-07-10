import { chmodSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, test } from "bun:test";
import { Ajv2020 as Ajv } from "ajv/dist/2020.js";
import { renderContent } from "../src/content.js";
import { digestCommit } from "../src/digest.js";
import { listCommits } from "../src/git.js";
import { renderIdentity, renderIdentityFrom, renderIdentityTo } from "../src/identity-view.js";
import { validateDigest } from "../src/index.js";
import { schemaVersion } from "../src/types.js";
import { verifyCommit, verifyDigest } from "../src/verify.js";
import { applyFiles, generatedCommitCase, replaceFiles } from "./support/generated-case.js";
import { cleanupTempDirectories, cli, commitAll, commitCanonicalTree, git, makeRepo, makeTempDir } from "./support/repo.js";

afterEach(cleanupTempDirectories);

describe("schema export", () => {
  test("ships a JSON schema for the canonical digest", () => {
    const schemaFileName = `${schemaVersion}.schema.json`;
    const schemaPath = join(import.meta.dir, "..", "schema", schemaFileName);
    expect(existsSync(schemaPath)).toBe(true);

    const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
    expect(schema).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: expect.stringContaining(schemaFileName),
      properties: {
        schema_version: { const: schemaVersion },
        algorithm: { $ref: "#/$defs/algorithm" },
        symbols: { type: "array" }
      }
    });
  });
});

describe("digest schema", () => {
  test("generated digests validate against the shipped schema", () => {
    const schema = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "schema", "git-trails.digest.v4.schema.json"), "utf8")
    );
    const ajv = new Ajv({ strict: false, allErrors: true });
    const validate = ajv.compile(schema);

    const repo = makeRepo();
    writeFileSync(join(repo, "a.txt"), "keep\nmove one\nmove two\nmove three\n");
    writeFileSync(join(repo, "b.txt"), "target\n");
    const root = commitAll(repo, "base");

    writeFileSync(join(repo, "a.txt"), "keep\nadd\n");
    writeFileSync(join(repo, "b.txt"), "target\nmove one\nmove two\nmove three\n");
    writeFileSync(join(repo, "bin.dat"), Buffer.from([0, 1, 2, 3]));
    writeFileSync(join(repo, "latin.txt"), Buffer.from([0x66, 0xff, 0x0a]));
    const moves = commitAll(repo, "moves, binary, non-utf8");

    chmodSync(join(repo, "b.txt"), 0o755);
    const modeOnly = commitAll(repo, "mode only");

    const digests = [root, moves, modeOnly].map((commit) => digestCommit({ cwd: repo, commit }));
    for (const digest of digests) {
      validate(digest);
      expect(validate.errors ?? []).toEqual([]);
    }

    // Guard that the fixtures still exercise the schema's conditional shapes.
    const [rootDigest, movesDigest, modeOnlyDigest] = digests;
    expect(rootDigest.parent).toBeNull();
    expect(rootDigest).not.toHaveProperty("repo");
    expect(rootDigest.algorithm).toMatchObject({
      name: "exact-line-sha256-identity-preserving",
      version: 3,
      anchor_min_alnum: 4,
      exact_block_fallback: true,
      whole_file_identity: true
    });
    expect(movesDigest.blocks.some((block) => block.payload_encoding === "base64")).toBe(true);
    expect(movesDigest.files.some((file) => file.unsupported_reason === "binary")).toBe(true);
    expect(movesDigest.identity.length).toBeGreaterThan(0);
    expect(modeOnlyDigest.files.some((file) => file.unsupported_reason === "mode_only")).toBe(true);

    const invalidInsert = JSON.parse(JSON.stringify(movesDigest));
    const moveBlock = invalidInsert.blocks.find((block: { kind: string }) => block.kind === "move");
    moveBlock.kind = "insert";
    expect(validate(invalidInsert)).toBe(false);
    expect(validate.errors ?? []).not.toEqual([]);
  });
});
