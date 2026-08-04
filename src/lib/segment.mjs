import fs from "node:fs";

export function segmentId(prefix, index) {
  return `${prefix}-${String(index).padStart(4, "0")}`;
}

export function loadPlainTextSegments(filePath, prefix) {
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.split(/\r?\n/).map((l) => l.trim());
  const nonEmpty = lines.filter((l) => l.length > 0);
  return nonEmpty.map((text, i) => ({
    id: segmentId(prefix, i + 1),
    index: i + 1,
    text,
  }));
}

export function assertSegmentCount(segments, expected) {
  if (segments.length !== expected) {
    throw new Error(
      `句段数不符：实际 ${segments.length}，asset-config.json 里 expectedSegments 是 ${expected}`
    );
  }
}
