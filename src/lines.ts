export interface LineRecord {
  path: string;
  lineNo: number;
  byteStart: number;
  byteEnd: number;
  bytes: Buffer;
  key: string;
  /** Whole-file record (binary mode): always eligible to anchor a pairing. */
  atomic?: boolean;
}

export function splitLineRecords(path: string, bytes: Buffer): LineRecord[] {
  const lines: LineRecord[] = [];
  let start = 0;
  let lineNo = 1;

  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0x0a) {
      continue;
    }
    const end = index + 1;
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

  if (start < bytes.length) {
    const line = Buffer.from(bytes.subarray(start));
    lines.push({
      path,
      lineNo,
      byteStart: start,
      byteEnd: bytes.length,
      bytes: line,
      key: lineKey(line)
    });
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

export function singleRecord(path: string, bytes: Buffer): LineRecord[] {
  if (bytes.length === 0) {
    return [];
  }
  return [
    {
      path,
      lineNo: 1,
      byteStart: 0,
      byteEnd: bytes.length,
      bytes: Buffer.from(bytes),
      key: lineKey(bytes),
      atomic: true
    }
  ];
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

export function previousLine(lines: LineRecord[], oneBasedLine: number): Buffer {
  if (oneBasedLine <= 1) {
    return Buffer.alloc(0);
  }
  return lines[oneBasedLine - 2]?.bytes ?? Buffer.alloc(0);
}

export function nextLine(lines: LineRecord[], oneBasedLine: number): Buffer {
  return lines[oneBasedLine]?.bytes ?? Buffer.alloc(0);
}

export function lineBeforeInsertion(lines: LineRecord[], insertBeforeLine: number): Buffer {
  if (insertBeforeLine <= 1) {
    return Buffer.alloc(0);
  }
  return lines[insertBeforeLine - 2]?.bytes ?? lines.at(-1)?.bytes ?? Buffer.alloc(0);
}

export function lineAfterInsertion(lines: LineRecord[], insertBeforeLine: number): Buffer {
  if (insertBeforeLine <= 0) {
    return lines[0]?.bytes ?? Buffer.alloc(0);
  }
  return lines[insertBeforeLine - 1]?.bytes ?? Buffer.alloc(0);
}

export function countLineBytes(bytes: Buffer): number {
  if (bytes.length === 0) {
    return 0;
  }

  let lines = 0;
  for (const byte of bytes) {
    if (byte === 0x0a) {
      lines += 1;
    }
  }
  return bytes[bytes.length - 1] === 0x0a ? lines : lines + 1;
}
