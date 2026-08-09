import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readLegacyXlsRows, extractSegmentsFromRows } from "./legacyXls.mjs";
import { ingestRawDocument } from "./rawIngest.mjs";
import { assetConfigPath, writeAssetConfig } from "./assetConfig.mjs";
import { workDirFor } from "./paths.mjs";
import { resolveLanguageProfile } from "./language.mjs";
import { assertHasSegments } from "./segment.mjs";

const MATERIAL_DIR = "01_原始材料";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function copyMaterial(inputPath, projectDir, destinationName) {
  const sourcePath = path.resolve(inputPath);
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
    throw new Error(`找不到原始材料：${sourcePath}`);
  }
  const relativePath = path.join(MATERIAL_DIR, destinationName || path.basename(sourcePath));
  const copiedPath = path.join(projectDir, relativePath);
  fs.mkdirSync(path.dirname(copiedPath), { recursive: true });
  fs.copyFileSync(sourcePath, copiedPath);
  if (sha256(sourcePath) !== sha256(copiedPath)) throw new Error(`原始材料复制校验失败：${sourcePath}`);
  return { copiedPath, relativePath };
}

export function stageProjectMaterials({ sourcePath, targetPath, projectDir }) {
  const source = copyMaterial(sourcePath, projectDir);
  let target = null;
  if (targetPath) {
    const targetName = `既有译文_${path.basename(targetPath)}`;
    target = copyMaterial(targetPath, projectDir, targetName);
  }
  return { source, target };
}

function prepareDocumentMaterial(material) {
  if (!material || path.extname(material.copiedPath).toLowerCase() !== ".doc") return material;
  const convertedName = `${path.basename(material.relativePath, ".doc")}_转换.docx`;
  const convertedRelativePath = path.join(MATERIAL_DIR, convertedName);
  const convertedPath = path.join(path.dirname(material.copiedPath), convertedName);
  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-File", path.join(SCRIPT_DIR, "legacyDocConvertCom.ps1"), "-Path", material.copiedPath, "-OutPath", convertedPath],
    { encoding: "utf8" },
  );
  if (result.status !== 0 || !fs.existsSync(convertedPath)) {
    throw new Error(`Word 转换 .doc 失败：${result.stderr || result.stdout || material.copiedPath}`);
  }
  return {
    copiedPath: convertedPath,
    relativePath: convertedRelativePath,
    originalRelativePath: material.relativePath,
  };
}

function deliveryTargetFile(title, materials, legacyXls = false) {
  const name = `${title}_译文.txt`;
  const reserved = [materials.source, materials.target]
    .filter(Boolean)
    .map((item) => path.basename(item.relativePath).toLocaleLowerCase("zh-CN"));
  const conflicts = reserved.includes(name.toLocaleLowerCase("zh-CN"))
    || (legacyXls && reserved.includes(name.replace(/\.txt$/i, ".xls").toLocaleLowerCase("zh-CN")));
  return path.join(MATERIAL_DIR, conflicts ? `交付_${name}` : name);
}

export function bootstrapFromLegacyXls({ xlsPath, projectDir, title, segmentPrefix, date, direction }) {
  const { source } = stageProjectMaterials({ sourcePath: xlsPath, projectDir });
  const rows = readLegacyXlsRows(source.copiedPath);
  const { segments, sections } = extractSegmentsFromRows(rows, segmentPrefix);
  assertHasSegments(segments, source.copiedPath);
  const language = resolveLanguageProfile(direction, segments);

  const config = {
    projectId: crypto.randomUUID(),
    title,
    date,
    sourceFile: source.relativePath,
    sourceFormat: path.extname(source.copiedPath).toLowerCase() === ".xlsx" ? "xlsx" : "legacy-xls",
    targetFile: deliveryTargetFile(title, { source }, true),
    sourceLanguage: language.sourceLanguage,
    targetLanguage: language.targetLanguage,
    sourceTermField: language.sourceTermField,
    targetTermField: language.targetTermField,
    languageLabel: language.languageLabel,
    sourceColumnLabel: language.sourceColumnLabel,
    targetColumnLabel: language.targetColumnLabel,
    segmentPrefix,
    domain: "",
    termStem: `${title}术语库_${language.languageLabel}_${date.replace(/-/g, "")}`,
    workbookName: `${title}_${language.languageLabel}对齐与术语库_${date.replace(/-/g, "")}.xlsx`,
    tmxName: `${title}_${language.languageLabel}翻译记忆_${date.replace(/-/g, "")}.tmx`,
    expectedSegments: segments.length,
    glossarySource: "99_项目配置与术语源数据/术语源数据.jsonl",
    documentTitleSegmentNumber: 1,
    headingSegmentNumbers: segments.filter((s) => s.isHeadingOrValue).map((s) => s.index),
    defaultTopic: "",
    sections: [],
  };

  writeAssetConfig(projectDir, config);

  const workDir = workDirFor(projectDir);
  fs.writeFileSync(
    path.join(workDir, "segments.json"),
    JSON.stringify({ segments, rawSections: sections }, null, 2),
    "utf8"
  );

  return { config, segments, sections, workDir };
}

export async function bootstrapFromRawDocument({ sourcePath, targetPath, projectDir, title, segmentPrefix, date, direction }) {
  const staged = stageProjectMaterials({ sourcePath, targetPath, projectDir });
  const materials = {
    source: prepareDocumentMaterial(staged.source),
    target: prepareDocumentMaterial(staged.target),
  };
  const { segments, sections } = await ingestRawDocument({
    sourcePath: materials.source.copiedPath,
    targetPath: materials.target?.copiedPath,
    segmentPrefix,
  });
  assertHasSegments(segments, materials.source.copiedPath);
  const language = resolveLanguageProfile(direction, segments);

  const config = {
    projectId: crypto.randomUUID(),
    title,
    date,
    sourceFile: materials.source.relativePath,
    originalSourceFile: materials.source.originalRelativePath || materials.source.relativePath,
    sourceFormat: "raw-document",
    sourceTargetFile: materials.target?.relativePath || "",
    sourceTargetOriginalFile: materials.target?.originalRelativePath || materials.target?.relativePath || "",
    targetFile: deliveryTargetFile(title, materials),
    sourceLanguage: language.sourceLanguage,
    targetLanguage: language.targetLanguage,
    sourceTermField: language.sourceTermField,
    targetTermField: language.targetTermField,
    languageLabel: language.languageLabel,
    sourceColumnLabel: language.sourceColumnLabel,
    targetColumnLabel: language.targetColumnLabel,
    segmentPrefix,
    domain: "",
    termStem: `${title}术语库_${language.languageLabel}_${date.replace(/-/g, "")}`,
    workbookName: `${title}_${language.languageLabel}对齐与术语库_${date.replace(/-/g, "")}.xlsx`,
    tmxName: `${title}_${language.languageLabel}翻译记忆_${date.replace(/-/g, "")}.tmx`,
    expectedSegments: segments.length,
    glossarySource: "99_项目配置与术语源数据/术语源数据.jsonl",
    documentTitleSegmentNumber: 1,
    headingSegmentNumbers: [],
    defaultTopic: "",
    sections: [],
  };

  writeAssetConfig(projectDir, config);

  const workDir = workDirFor(projectDir);
  fs.writeFileSync(
    path.join(workDir, "segments.json"),
    JSON.stringify({ segments, rawSections: sections }, null, 2),
    "utf8"
  );

  return { config, segments, sections, workDir };
}
