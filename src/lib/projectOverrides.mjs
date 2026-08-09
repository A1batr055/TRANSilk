import fs from "node:fs";
import path from "node:path";
import { termFields } from "./language.mjs";
import { readSimpleWorkbook, writeSimpleWorkbook } from "./xlsx.mjs";

const STATE_DIR = "99_项目配置与术语源数据";
const WORKBOOK_NAME = "项目专用译法.xlsx";
const LEGACY_NAME = "overrides.json";
const HEADERS = ["原文术语", "指定译文"];

export function projectOverridesPath(projectDir) {
  return path.join(projectDir, STATE_DIR, WORKBOOK_NAME);
}

export async function ensureProjectOverridesWorkbook(projectDir) {
  const filePath = projectOverridesPath(projectDir);
  if (fs.existsSync(filePath)) return filePath;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const buffer = await writeSimpleWorkbook({
    sheetName: "项目专用译法",
    headers: HEADERS,
    rows: [],
  });
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

export async function readProjectOverridesWorkbook(projectDir) {
  const filePath = projectOverridesPath(projectDir);
  if (!fs.existsSync(filePath)) return [];
  const { headers, rows, rowNumbers } = await readSimpleWorkbook(fs.readFileSync(filePath));
  if (JSON.stringify(headers) !== JSON.stringify(HEADERS)) {
    throw new Error(`项目专用译法表头必须为“${HEADERS.join("、")}”：${filePath}`);
  }
  const entries = [];
  const seen = new Map();
  rows.forEach((row, index) => {
    const excelRow = rowNumbers[index];
    const sourceTerm = String(row[0] ?? "").trim();
    const targetTerm = String(row[1] ?? "").trim();
    if (!sourceTerm && !targetTerm) return;
    if (!sourceTerm || !targetTerm) {
      throw new Error(`项目专用译法第 ${excelRow} 行必须同时填写原文术语和指定译文`);
    }
    if (seen.has(sourceTerm)) {
      throw new Error(`项目专用译法第 ${excelRow} 行与第 ${seen.get(sourceTerm)} 行的原文术语重复：${sourceTerm}`);
    }
    seen.set(sourceTerm, excelRow);
    entries.push({ sourceTerm, targetTerm, excelRow });
  });
  return entries;
}

function legacyOverrides(projectDir) {
  const filePath = path.join(projectDir, STATE_DIR, LEGACY_NAME);
  if (!fs.existsSync(filePath)) return {};
  const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`旧版项目专用译法不是有效对象：${filePath}`);
  }
  return value;
}

function targetOf(value, targetField, key) {
  const target = typeof value === "string" ? value : value?.[targetField];
  const normalized = String(target ?? "").trim();
  if (!normalized) throw new Error(`旧版项目专用译法缺少指定译文：${key}`);
  return normalized;
}

function sourceOfLegacyKey(key) {
  const separator = key.lastIndexOf("::");
  return separator < 0 ? key : key.slice(0, separator);
}

function overrideFor(overrides, sourceTerm, domain) {
  const scoped = overrides[`${sourceTerm}::${domain}`];
  return scoped !== undefined ? scoped : overrides[sourceTerm];
}

function nextCandidateNumber(candidates) {
  return candidates.reduce((max, candidate) => {
    const match = String(candidate.id ?? "").match(/^CAND-(\d+)$/);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0) + 1;
}

function addedCandidate(entry, segment, config, number) {
  const { sourceField, targetField } = termFields(config);
  return {
    id: `CAND-${String(number).padStart(4, "0")}`,
    sourceTermField: sourceField,
    targetTermField: targetField,
    [sourceField]: entry.sourceTerm,
    [targetField]: entry.targetTerm,
    ...(sourceField === "zh_CN" || targetField === "zh_CN" ? {
      zh_CN: sourceField === "zh_CN" ? entry.sourceTerm : entry.targetTerm,
    } : {}),
    ...(sourceField === "en_US" || targetField === "en_US" ? {
      en_US: sourceField === "en_US" ? entry.sourceTerm : entry.targetTerm,
    } : {}),
    translation_action: "translate",
    translation_action_reason: "",
    part_of_speech: "",
    domain: config.domain || "",
    definition: "",
    note: "",
    definition_zh: "",
    note_zh: "",
    source_segment_id: segment.id,
  };
}

export async function applyProjectOverrides(candidates, segments, config, projectDir) {
  const { sourceField, targetField } = termFields(config);
  const workbookEntries = await readProjectOverridesWorkbook(projectDir);
  const legacy = legacyOverrides(projectDir);
  const overrides = { ...legacy };

  for (const entry of workbookEntries) {
    for (const [key, value] of Object.entries(legacy)) {
      if (sourceOfLegacyKey(key) !== entry.sourceTerm) continue;
      const legacyTarget = targetOf(value, targetField, key);
      if (legacyTarget !== entry.targetTerm) {
        throw new Error(`项目专用译法与旧版 overrides.json 冲突：${entry.sourceTerm}`);
      }
    }
    overrides[entry.sourceTerm] = entry.targetTerm;
  }

  const resolved = candidates.map((candidate) => {
    const override = overrideFor(overrides, candidate[sourceField], candidate.domain || config.domain);
    if (override === undefined) return candidate;
    return {
      ...candidate,
      [targetField]: targetOf(override, targetField, candidate[sourceField]),
      translation_action: "translate",
      translation_action_reason: "",
    };
  });

  let nextNumber = nextCandidateNumber(resolved);
  const missing = [];
  let added = 0;
  for (const entry of workbookEntries) {
    if (resolved.some((candidate) => candidate[sourceField] === entry.sourceTerm)) continue;
    const segment = segments.find((item) => String(item.text ?? "").includes(entry.sourceTerm));
    if (!segment) {
      missing.push(entry);
      continue;
    }
    resolved.push(addedCandidate(entry, segment, config, nextNumber));
    nextNumber += 1;
    added += 1;
  }

  return { candidates: resolved, overrides, workbookEntries, missing, added };
}
