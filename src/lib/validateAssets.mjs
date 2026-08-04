import fs from "node:fs";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";
import { segmentId } from "./segment.mjs";
import { projectSubdir } from "./paths.mjs";
import { readAssetWorkbook } from "./assetWorkbook.mjs";
import { termFields } from "./language.mjs";


function readLines(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function readJsonlCount(filePath) {
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean).length;
}

function asArray(node) {
  if (node === undefined || node === null) return [];
  return Array.isArray(node) ? node : [node];
}

export async function validateAssets(config, projectDir, precomputed) {
  const mainDir = projectSubdir(projectDir, "02_双语对齐工作簿");
  const exchangeDir = projectSubdir(projectDir, "03_翻译记忆与术语交换文件");

  let sourceLines, targetLines;
  if (precomputed) {
    ({ sourceLines, targetLines } = precomputed);
  } else {
    const sourceDir = projectSubdir(projectDir, "01_原始材料");
    sourceLines = readLines(path.join(sourceDir, config.sourceFile));
    targetLines = readLines(path.join(sourceDir, config.targetFile));
  }
  if (sourceLines.length !== targetLines.length) {
    throw new Error(`原文与译文句段数不一致：原文 ${sourceLines.length}，译文 ${targetLines.length}`);
  }

  const glossaryPath = path.join(projectDir, config.glossarySource);
  const glossaryCount = fs.existsSync(glossaryPath) ? readJsonlCount(glossaryPath) : 0;

  const workbookPath = path.join(mainDir, config.workbookName);
  const { sheetNames, sheets } = await readAssetWorkbook(fs.readFileSync(workbookPath));

  const expectedSheets = ["使用说明", "句段对齐", "术语库"];
  if (JSON.stringify(sheetNames) !== JSON.stringify(expectedSheets)) {
    throw new Error(`sheet名或顺序不对：期望 ${expectedSheets.join(",")}，实际 ${sheetNames.join(",")}`);
  }

  const align = sheets["句段对齐"];
  const terms = sheets["术语库"];
  const expectedAlignRowCount = sourceLines.length + 3;
  const expectedTermRowCount = glossaryCount + 3;
  if (align.rowCount !== expectedAlignRowCount) {
    throw new Error(`句段对齐行数不对：期望 ${expectedAlignRowCount}，实际 ${align.rowCount}`);
  }
  if (terms.rowCount !== expectedTermRowCount) {
    throw new Error(`术语库行数不对：期望 ${expectedTermRowCount}，实际 ${terms.rowCount}`);
  }

  const expectedAlignFilter = `A3:F${expectedAlignRowCount}`;
  const expectedTermFilter = `A3:M${expectedTermRowCount}`;
  if (align.autoFilter !== expectedAlignFilter) {
    throw new Error(`句段对齐autoFilter不对：期望 ${expectedAlignFilter}，实际 ${align.autoFilter}`);
  }
  if (terms.autoFilter !== expectedTermFilter) {
    throw new Error(`术语库autoFilter不对：期望 ${expectedTermFilter}，实际 ${terms.autoFilter}`);
  }

  for (const [name, sheet] of [["句段对齐", align], ["术语库", terms]]) {
    const f = sheet.freeze;
    if (!f || f.state !== "frozen" || f.xSplit !== 3 || f.ySplit !== 3) {
      throw new Error(`${name}冻结窗格不对：${JSON.stringify(f)}`);
    }
  }

  const alignmentRows = align.rows.slice(3);
  const alignmentIds = [];
  alignmentRows.forEach((row, i) => {
    const [id, type, topic, source, target, status] = row;
    if ([id, type, topic, source, target, status].some((v) => !v)) {
      throw new Error(`句段对齐第 ${i + 4} 行有空单元格`);
    }
    if (source !== sourceLines[i]) {
      throw new Error(`句段对齐第 ${i + 4} 行原文跟输入句段不一致`);
    }
    if (target !== targetLines[i]) {
      throw new Error(`句段对齐第 ${i + 4} 行译文跟输入句段不一致`);
    }
    alignmentIds.push(id);
  });
  if (alignmentIds.length > 0) {
    const expectedFirstId = segmentId(config.segmentPrefix, 1);
    const expectedLastId = segmentId(config.segmentPrefix, alignmentIds.length);
    if (alignmentIds[0] !== expectedFirstId) {
      throw new Error(`句段对齐首行ID不对：期望 ${expectedFirstId}，实际 ${alignmentIds[0]}`);
    }
    if (alignmentIds[alignmentIds.length - 1] !== expectedLastId) {
      throw new Error(`句段对齐末行ID不对：期望 ${expectedLastId}，实际 ${alignmentIds[alignmentIds.length - 1]}`);
    }
  }
  if (new Set(alignmentIds).size !== alignmentIds.length) {
    throw new Error("句段对齐存在重复ID");
  }

  const termRows = terms.rows.slice(3);
  const { sourceField, targetField } = termFields(config);
  const sourceIdPattern = new RegExp(`^${config.segmentPrefix}-\\d{4}$`);
  const seenTermKeys = new Set();
  termRows.forEach((row, i) => {
    const [, sourceTerm, targetTerm, , , , , , , sourceSeg] = row;
    if (!sourceTerm || !targetTerm) {
      throw new Error(`术语库第 ${i + 4} 行核心字段（${sourceField}/${targetField}）为空`);
    }
    const key = `${sourceTerm}|${targetTerm}`;
    if (seenTermKeys.has(key)) {
      throw new Error(`术语库第 ${i + 4} 行中英文组合重复：${key}`);
    }
    seenTermKeys.add(key);
    if (sourceSeg) {
      if (!sourceIdPattern.test(sourceSeg)) {
        throw new Error(`术语库第 ${i + 4} 行来源句段格式不对：${sourceSeg}`);
      }
      if (!alignmentIds.includes(sourceSeg)) {
        throw new Error(`术语库第 ${i + 4} 行来源句段在句段对齐表里查不到：${sourceSeg}`);
      }
    }
  });

  const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });

  const tmxPath = path.join(exchangeDir, config.tmxName);
  const tmxDoc = parser.parse(fs.readFileSync(tmxPath, "utf8"));
  const tuCount = asArray(tmxDoc.tmx?.body?.tu).length;
  if (tuCount !== alignmentRows.length) {
    throw new Error(`TMX的tu数量(${tuCount})跟句段对齐行数(${alignmentRows.length})对不上`);
  }

  const tbxPath = path.join(exchangeDir, `${config.termStem}.tbx`);
  const tbxDoc = parser.parse(fs.readFileSync(tbxPath, "utf8"));
  const conceptCount = asArray(tbxDoc.tbx?.text?.body?.conceptEntry).length;
  if (conceptCount !== termRows.length) {
    throw new Error(`TBX的conceptEntry数量(${conceptCount})跟术语库行数(${termRows.length})对不上`);
  }

  const jsonlPath = path.join(exchangeDir, `${config.termStem}.jsonl`);
  const jsonlCount = fs.existsSync(jsonlPath) ? readJsonlCount(jsonlPath) : 0;
  if (jsonlCount !== termRows.length) {
    throw new Error(`JSONL条目数量(${jsonlCount})跟术语库行数(${termRows.length})对不上`);
  }

  return {
    workbookPath,
    sheets: sheetNames,
    alignRows: alignmentRows.length,
    termRows: termRows.length,
    firstAlignmentId: alignmentIds[0] ?? null,
    lastAlignmentId: alignmentIds[alignmentIds.length - 1] ?? null,
    tmx: tuCount,
    tbx: conceptCount,
    jsonl: jsonlCount,
  };
}
