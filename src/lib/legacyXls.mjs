import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { segmentId } from "./segment.mjs";
import { runtimeTempFile } from "./paths.mjs";

const SCRIPT_DIR = path.dirname(url.fileURLToPath(import.meta.url));


function isBlankRow(row) {
  return !row.seq?.trim() && !row.source?.trim() && !row.target?.trim();
}

function isHeaderRepeatRow(row) {
  return row.seq?.trim() === "序号" && row.source?.trim() === "原文";
}

export function looksLikeHeadingOrValue(text) {
  const t = text.trim();
  if (t.length === 0) return false;
  if (/[。！？：；]$/.test(t)) return false;
  return t.length <= 20;
}

export function readLegacyXlsRows(xlsPath) {
  const scriptPath = path.join(SCRIPT_DIR, "legacyXlsCom.ps1");
  const outPath = runtimeTempFile("xls-read", ".json");
  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-File", scriptPath, "-Path", xlsPath, "-OutPath", outPath],
    { encoding: "utf8" }
  );
  if (result.status !== 0) {
    if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
    throw new Error(`Excel COM 读取表格失败：${result.stderr || result.stdout}`);
  }
  try {
    let text = fs.readFileSync(outPath, "utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const raw = JSON.parse(text);
    return Array.isArray(raw) ? raw : [raw];
  } finally {
    if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
  }
}

export function extractSegmentsFromRows(rows, prefix) {
  const segments = [];
  const sections = [];
  let index = 0;
  let pendingNewSection = true;

  for (const row of rows) {
    if (isBlankRow(row) || isHeaderRepeatRow(row)) {
      pendingNewSection = true;
      continue;
    }
    index += 1;
    if (pendingNewSection) {
      sections.push({ start: index });
      pendingNewSection = false;
    }
    segments.push({
      id: segmentId(prefix, index),
      index,
      text: row.source.trim(),
      originalSeq: row.seq?.trim() ?? "",
      isHeadingOrValue: looksLikeHeadingOrValue(row.source),
      excelRow: row.row,
    });
  }

  return { segments, sections };
}

export function writeLegacyXlsTranslations(sourceXlsPath, outXlsPath, rowTexts) {
  const scriptPath = path.join(SCRIPT_DIR, "legacyXlsWriteCom.ps1");
  const jsonPath = runtimeTempFile("xls-write", ".json");
  fs.writeFileSync(jsonPath, JSON.stringify(rowTexts), "utf8");
  const result = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      scriptPath,
      "-SourcePath",
      sourceXlsPath,
      "-OutPath",
      outXlsPath,
      "-TranslationsJsonPath",
      jsonPath,
    ],
    { encoding: "utf8" }
  );
  if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath);
  if (result.status !== 0) {
    throw new Error(`Excel COM 写回表格失败：${result.stderr || result.stdout}`);
  }
  return outXlsPath;
}
