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

describe("renderContent", () => {
  test("renders compact content op lines", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "a.ts"), "export function first() {}\nexport function second() {}\nexport function third() {}\n");
    commitAll(repo, "base");

    writeFileSync(join(repo, "b.ts"), "export function first() {}\nexport function second() {}\nexport function third() {}\n");
    writeFileSync(join(repo, "a.ts"), "export const replacement = true;\nexport const fresh = 1;\n");
    const commit = commitAll(repo, "cut-paste with name reuse");

    const lines = renderContent(digestCommit({ cwd: repo, commit })).trimEnd().split("\n");
    expect(lines).toEqual([
      "M a.ts:1+3 -> b.ts:1+3",
      "+ a.ts:1+2"
    ]);
  });

  test("renders pairwise identity flows", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "a.ts"), "export function first() {}\nexport function second() {}\nexport function third() {}\n");
    commitAll(repo, "base");

    writeFileSync(join(repo, "b.ts"), "export function first() {}\nexport function second() {}\nexport function third() {}\n");
    writeFileSync(join(repo, "a.ts"), "export const replacement = true;\nexport const fresh = 1;\n");
    const commit = commitAll(repo, "cut-paste with name reuse");

    expect(renderIdentity(digestCommit({ cwd: repo, commit }))).toBe("a.ts:3 -> b.ts:3 (3)\n");
  });
});
