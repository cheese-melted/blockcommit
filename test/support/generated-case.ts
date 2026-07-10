import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface GeneratedFile {
  content: Buffer;
  executable?: boolean;
}

export function applyFiles(repo: string, files: Record<string, GeneratedFile>): void {
  for (const [path, file] of Object.entries(files)) {
    writeRepoFile(repo, path, file);
  }
}

export function replaceFiles(
  repo: string,
  oldFiles: Record<string, GeneratedFile>,
  newFiles: Record<string, GeneratedFile>
): void {
  for (const path of Object.keys(oldFiles)) {
    if (!(path in newFiles)) {
      rmSync(join(repo, path), { force: true });
    }
  }
  applyFiles(repo, newFiles);
}

export function generatedCommitCase(seed: number): {
  oldFiles: Record<string, GeneratedFile>;
  newFiles: Record<string, GeneratedFile>;
} {
  const random = seededRandom(seed);
  const oldA = generatedLines(seed, "a", 24, random);
  const oldB = generatedLines(seed, "b", 20, random);
  const oldLarge = generatedLines(seed, "large", 140, random);
  const split = generatedLines(seed, "split", 18, random);
  const mergeOne = generatedLines(seed, "merge_one", 12, random);
  const mergeTwo = generatedLines(seed, "merge_two", 12, random);

  const oldFiles: Record<string, GeneratedFile> = {
    "a.ts": textFile(oldA),
    "b.ts": textFile(oldB),
    "large.txt": textFile(oldLarge),
    "script.sh": textFile(["echo base\n"], { executable: false }),
    "split.ts": textFile(split),
    "merge-one.ts": textFile(mergeOne),
    "merge-two.ts": textFile(mergeTwo),
    [`unicode-${seed}-é.txt`]: textFile([`héllo ${seed}\n`, "repeat();\n"], { finalNewline: seed % 2 === 0 }),
    "nonutf8.txt": mixedTextFile("old", seed)
  };

  const movedFromA = oldA.slice(2, 9);
  const reorderedA = shuffled(oldA.slice(9, 18), random);
  const reorderedB = shuffled(oldB.slice(3, 15), random);
  const largePrefix = oldLarge.slice(0, 20);
  const largeMiddle = oldLarge.slice(60, 95);
  const largeSuffix = oldLarge.slice(120);

  const newFiles: Record<string, GeneratedFile> = {
    "a.ts": textFile([
      `fresh_a_${seed}();\n`,
      ...reorderedA,
      "repeat();\n",
      "\n",
      "}\n"
    ], { finalNewline: seed % 3 !== 0 }),
    "b.ts": textFile([
      ...oldB.slice(0, 3),
      ...movedFromA,
      `fresh_b_${seed}();\n`,
      ...reorderedB
    ]),
    "large.txt": textFile([
      ...largePrefix,
      `large_insert_${seed}();\n`,
      ...largeSuffix,
      ...largeMiddle
    ]),
    "script.sh": textFile(["echo base\n", `echo changed ${seed}\n`], { executable: true }),
    "split-left.ts": textFile(split.slice(0, 9)),
    "split-right.ts": textFile(split.slice(9)),
    "merged.ts": textFile([...mergeTwo.slice(0, 6), ...mergeOne, ...mergeTwo.slice(6)]),
    [`unicode-${seed}-é.txt`]: textFile([`héllo ${seed}\n`, ...movedFromA.slice(0, 2), `fin ${seed}\n`], {
      finalNewline: seed % 2 !== 0
    }),
    "nonutf8.txt": {
      content: Buffer.concat([
        Buffer.from(`new start ${seed}\n`, "utf8"),
        Buffer.from([0xfa, 0xfb, 0x0a]),
        Buffer.from(`new end ${seed}`, "utf8")
      ])
    }
  };

  return { oldFiles, newFiles };
}

function writeRepoFile(repo: string, path: string, file: GeneratedFile): void {
  const fullPath = join(repo, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, file.content);
  if (file.executable === true) {
    chmodSync(fullPath, 0o755);
  }
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function shuffled<T>(values: T[], random: () => number): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function textFile(lines: string[], options: { finalNewline?: boolean; executable?: boolean } = {}): GeneratedFile {
  let text = lines.join("");
  if (options.finalNewline === false && text.endsWith("\n")) {
    text = text.slice(0, -1);
  }
  return { content: Buffer.from(text, "utf8"), executable: options.executable };
}

function mixedTextFile(prefix: string, seed: number): GeneratedFile {
  return {
    content: Buffer.concat([
      Buffer.from(`${prefix} start ${seed}\n`, "utf8"),
      Buffer.from([0xff, 0xfe, 0x0a]),
      Buffer.from(`${prefix} end ${seed}\n`, "utf8")
    ])
  };
}

function generatedLines(seed: number, name: string, count: number, random: () => number): string[] {
  const repeated = [
    "repeat();\n",
    "repeat();\n",
    "\n",
    "}\n",
    "{\n",
    "x=1\n",
    "case shared:\n",
    "return value;\n"
  ];
  const lines: string[] = [];
  for (let index = 0; index < count; index += 1) {
    if (index % 5 === 0) {
      lines.push(`${name}_unique_${seed}_${index}();\n`);
    } else {
      lines.push(repeated[Math.floor(random() * repeated.length)]);
    }
  }
  return lines;
}
