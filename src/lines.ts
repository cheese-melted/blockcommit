export interface LineRecord {
  path: string;
  lineNo: number;
  byteStart: number;
  byteEnd: number;
  bytes: Buffer;
  key: string;
  /** Memoized anchor eligibility, filled in lazily during pairing. */
  anchorEligible?: boolean;
}

export function splitLineRecords(path: string, bytes: Buffer): LineRecord[] {
  const lines: LineRecord[] = [];
  let start = 0;
  let lineNo = 1;

  while (start < bytes.length) {
    const newline = bytes.indexOf(0x0a, start);
    const end = newline === -1 ? bytes.length : newline + 1;
    const line = Buffer.from(bytes.subarray(start, end));
    lines.push({
      path,
      lineNo,
      byteStart: start,
      byteEnd: end,
      bytes: line,
      key: lineKey(line)
    });
    start = end;
    lineNo += 1;
  }

  return lines;
}

export function lineKey(bytes: Buffer): string {
  return bytes.toString("latin1");
}

const binarySniffBytes = 8000;

export function isBinary(bytes: Buffer): boolean {
  const end = Math.min(bytes.length, binarySniffBytes);
  return bytes.subarray(0, end).includes(0);
}

export function concatLineBytes(lines: LineRecord[]): Buffer {
  return Buffer.concat(lines.map((line) => line.bytes));
}

export function spanForLines(lines: LineRecord[]): {
  path: string;
  start_line: number;
  end_line: number;
  line_count: number;
  byte_start: number;
  byte_end: number;
} {
  if (lines.length === 0) {
    throw new Error("cannot build a span from zero lines");
  }

  const first = lines[0];
  const last = lines[lines.length - 1];
  return {
    path: first.path,
    start_line: first.lineNo,
    end_line: last.lineNo,
    line_count: last.lineNo - first.lineNo + 1,
    byte_start: first.byteStart,
    byte_end: last.byteEnd
  };
}

export function countLineBytes(bytes: Buffer): number {
  if (bytes.length === 0) {
    return 0;
  }

  let lines = 0;
  let index = bytes.indexOf(0x0a);
  while (index !== -1) {
    lines += 1;
    index = bytes.indexOf(0x0a, index + 1);
  }
  return bytes[bytes.length - 1] === 0x0a ? lines : lines + 1;
}
