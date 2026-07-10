import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

describe("packed package consumer fixture", () => {
  test("uses a strict NodeNext ESM project and the public types fallback", () => {
    const packageJson = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"));
    const fixturePackage = JSON.parse(
      readFileSync(join(import.meta.dir, "fixtures", "node-next-consumer", "package.json"), "utf8")
    );
    const fixtureTsconfig = JSON.parse(
      readFileSync(join(import.meta.dir, "fixtures", "node-next-consumer", "tsconfig.json"), "utf8")
    );
    const fixtureSource = readFileSync(
      join(import.meta.dir, "fixtures", "node-next-consumer", "index.ts"),
      "utf8"
    );

    expect(packageJson.types).toBe("./dist/index.d.ts");
    expect(packageJson.exports["."].types).toBe("./dist/index.d.ts");
    expect(fixturePackage.type).toBe("module");
    expect(fixtureTsconfig.compilerOptions).toMatchObject({
      module: "NodeNext",
      moduleResolution: "NodeNext",
      noEmit: true,
      strict: true
    });
    expect(fixtureSource).toContain('from "git-trails"');
    expect(fixtureSource).toContain("type GitTrailsDigest");
  });
});
