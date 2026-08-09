import fs from "node:fs";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";
import { segmentId } from "./segment.mjs";
import { projectSubdir } from "./paths.mjs";
import { readAssetWorkbook } from "./assetWorkbook.mjs";
import { termFields, reusableGlossaryTerms } from "./language.mjs";


function readLines(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function readJsonl(filePath) {
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function asArray(node) {
  if (node === undefined || node === null) return [];
  return Array.isArray(node) ? node : [node];
}

function textOf(node) {
  if (node === undefined || node === null) return "";
  if (typeof node === "object") return String(node["#text"] ?? "");
  return String(node);
}

function assertTermCore(actual, expected, label, sourceField, targetField, index) {
  const fields = ["id", sourceField, targetField, "domain", "status"];
  for (const field of fields) {
    const actualValue = String(actual[field] ?? "");
    const expectedValue = String(expected[field] ?? (field === "status" ? "首选" : ""));
    if (actualValue !== expectedValue) {
      throw new Error(`${label}第 ${index + 1} 条术语字段 ${field} 不一致：应为 ${expectedValue}，实际为 ${actualValue}`);
    }
  }
}

function workbookTermRows(sheet, sourceField, targetField) {
  const headers = sheet.rows[2] ?? [];
  const required = ["ID", "领域", "状态"];
  for (const header of required) {
    if (!headers.includes(header)) throw new Error(`术语库缺少列：${header}`);
  }
  return sheet.rows.slice(3).map((row) => ({
    id: row[headers.indexOf("ID")],
    [sourceField]: row[1],
    [targetField]: row[2],
    domain: row[headers.indexOf("领域")],
    status: row[headers.indexOf("状态")],
  }));
}

function tbxTermRows(doc, config, sourceField, targetField) {
  const concepts = asArray(doc.tbx?.text?.body?.conceptEntry);
  return concepts.map((concept) => {
    const descriptions = asArray(concept.descrip);
    const domain = descriptions.find((item) => item?.["@_type"] === "subjectField");
    const languages = asArray(concept.langSec);
    const termFor = (language) => {
      const section = languages.find((item) => (item?.["@_lang"] ?? item?.["@_xml:lang"]) === language);
      return textOf(asArray(section?.termSec)[0]?.term);
    };
    return {
      id: String(concept["@_id"] ?? ""),
      [sourceField]: termFor(config.sourceLanguage),
      [targetField]: termFor(config.targetLanguage),
      domain: textOf(domain),
      status: "首选",
    };
  });
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
  const glossaryRaw = fs.existsSync(glossaryPath)
    ? fs
        .readFileSync(glossaryPath, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
  const expectedGlossary = reusableGlossaryTerms(glossaryRaw, config).map((term) => ({
    ...term,
    status: term.status || "首选",
    domain: term.domain || config.domain || "",
  }));
  const glossaryCount = expectedGlossary.length;

  const workbookPath = path.join(mainDir, config.workbookName);
  const { sheetNames, sheets } = await readAssetWorkbook(fs.readFileSync(workbookPath));

  const expectedSheets = ["使用说明", "句段对齐", "术语库"];
  if (JSON.stringify(sheetNames) !== JSON.stringify(expectedSheets)) {
    throw new Error(`工作表名称或顺序不正确：应为 ${expectedSheets.join("、")}，实际为 ${sheetNames.join("、")}`);
  }

  const align = sheets["句段对齐"];
  const terms = sheets["术语库"];
  const expectedAlignRowCount = sourceLines.length + 3;
  const expectedTermRowCount = glossaryCount + 3;
  if (align.rowCount !== expectedAlignRowCount) {
    throw new Error(`句段对齐行数不一致：应为 ${expectedAlignRowCount} 行，实际为 ${align.rowCount} 行`);
  }
  if (terms.rowCount !== expectedTermRowCount) {
    throw new Error(`术语库行数不一致：应为 ${expectedTermRowCount} 行，实际为 ${terms.rowCount} 行`);
  }

  const expectedAlignFilter = `A3:F${expectedAlignRowCount}`;
  const expectedTermFilter = `A3:P${expectedTermRowCount}`;
  if (align.autoFilter !== expectedAlignFilter) {
    throw new Error(`句段对齐自动筛选区域不一致：应为 ${expectedAlignFilter}，实际为 ${align.autoFilter}`);
  }
  if (terms.autoFilter !== expectedTermFilter) {
    throw new Error(`术语库自动筛选区域不一致：应为 ${expectedTermFilter}，实际为 ${terms.autoFilter}`);
  }

  for (const [name, sheet] of [["句段对齐", align], ["术语库", terms]]) {
    const f = sheet.freeze;
    if (!f || f.state !== "frozen" || f.xSplit !== 3 || f.ySplit !== 3) {
      throw new Error(`${name}的冻结窗格设置不正确：${JSON.stringify(f)}`);
    }
  }

  const alignmentRows = align.rows.slice(3);
  const alignmentIds = [];
  alignmentRows.forEach((row, i) => {
    const [id, type, topic, source, target, status] = row;
    if ([id, type, topic, source, target, status].some((v) => !v)) {
      throw new Error(`句段对齐第 ${i + 4} 行存在空白单元格`);
    }
    if (source !== sourceLines[i]) {
      throw new Error(`句段对齐第 ${i + 4} 行原文与输入句段不一致`);
    }
    if (target !== targetLines[i]) {
      throw new Error(`句段对齐第 ${i + 4} 行译文与输入句段不一致`);
    }
    alignmentIds.push(id);
  });
  if (alignmentIds.length > 0) {
    const expectedFirstId = segmentId(config.segmentPrefix, 1);
    const expectedLastId = segmentId(config.segmentPrefix, alignmentIds.length);
    if (alignmentIds[0] !== expectedFirstId) {
      throw new Error(`句段对齐首行 ID 不一致：应为 ${expectedFirstId}，实际为 ${alignmentIds[0]}`);
    }
    if (alignmentIds[alignmentIds.length - 1] !== expectedLastId) {
      throw new Error(`句段对齐末行 ID 不一致：应为 ${expectedLastId}，实际为 ${alignmentIds[alignmentIds.length - 1]}`);
    }
  }
  if (new Set(alignmentIds).size !== alignmentIds.length) {
    throw new Error("句段对齐存在重复 ID");
  }

  const { sourceField, targetField } = termFields(config);
  const termRows = workbookTermRows(terms, sourceField, targetField);
  termRows.forEach((term, index) => assertTermCore(term, expectedGlossary[index] ?? {}, "工作簿", sourceField, targetField, index));
  const sourceIdPattern = new RegExp(`^${config.segmentPrefix}-\\d{4}$`);
  const seenTermKeys = new Set();
  terms.rows.slice(3).forEach((row, i) => {
    const headers = terms.rows[2];
    const sourceTerm = row[1];
    const targetTerm = row[2];
    const sourceSeg = row[headers.indexOf("来源句段")];
    if (!sourceTerm || !targetTerm) {
      throw new Error(`术语库第 ${i + 4} 行核心字段（${sourceField}/${targetField}）为空`);
    }
    const key = `${sourceTerm}|${targetTerm}`;
    if (seenTermKeys.has(key)) {
      throw new Error(`术语库第 ${i + 4} 行的原文术语与译文术语组合重复：${key}`);
    }
    seenTermKeys.add(key);
    if (sourceSeg) {
      if (!sourceIdPattern.test(sourceSeg)) {
        throw new Error(`术语库第 ${i + 4} 行的来源句段格式不正确：${sourceSeg}`);
      }
      if (!alignmentIds.includes(sourceSeg)) {
        throw new Error(`术语库第 ${i + 4} 行的来源句段未在句段对齐表中找到：${sourceSeg}`);
      }
    }
  });

  const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });

  const tmxPath = path.join(exchangeDir, config.tmxName);
  const tmxDoc = parser.parse(fs.readFileSync(tmxPath, "utf8"));
  const tuCount = asArray(tmxDoc.tmx?.body?.tu).length;
  if (tuCount !== alignmentRows.length) {
    throw new Error(`TMX 句段单元数量（${tuCount}）与句段对齐行数（${alignmentRows.length}）不一致`);
  }

  const tbxPath = path.join(exchangeDir, `${config.termStem}.tbx`);
  const tbxDoc = parser.parse(fs.readFileSync(tbxPath, "utf8"));
  const tbxTerms = tbxTermRows(tbxDoc, config, sourceField, targetField);
  const conceptCount = tbxTerms.length;
  if (conceptCount !== termRows.length) {
    throw new Error(`TBX 术语条目数量（${conceptCount}）与术语库行数（${termRows.length}）不一致`);
  }
  tbxTerms.forEach((term, index) => assertTermCore(term, expectedGlossary[index] ?? {}, "TBX", sourceField, targetField, index));

  const jsonlPath = path.join(exchangeDir, `${config.termStem}.jsonl`);
  const jsonlTerms = fs.existsSync(jsonlPath) ? readJsonl(jsonlPath) : [];
  const jsonlCount = jsonlTerms.length;
  if (jsonlCount !== termRows.length) {
    throw new Error(`JSONL 术语条目数量（${jsonlCount}）与术语库行数（${termRows.length}）不一致`);
  }
  jsonlTerms.forEach((term, index) => assertTermCore(term, expectedGlossary[index] ?? {}, "JSONL", sourceField, targetField, index));

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
