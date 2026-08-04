import fs from "node:fs";
import path from "node:path";

export const REQUIRED_FIELDS = [
  "title",
  "date",
  "sourceFile",
  "targetFile",
  "sourceLanguage",
  "targetLanguage",
  "languageLabel",
  "sourceColumnLabel",
  "targetColumnLabel",
  "segmentPrefix",
  "domain",
  "termStem",
  "workbookName",
  "tmxName",
  "expectedSegments",
  "glossarySource",
  "documentTitleSegmentNumber",
  "headingSegmentNumbers",
  "defaultTopic",
  "sections",
];

const CONFIG_RELATIVE_PATH = path.join("99_项目配置与术语源数据", "asset-config.json");

export function assetConfigPath(projectDir) {
  return path.join(projectDir, CONFIG_RELATIVE_PATH);
}

export function readAssetConfig(projectDir) {
  const p = assetConfigPath(projectDir);
  if (!fs.existsSync(p)) {
    throw new Error(`未找到 asset-config.json：${p}`);
  }
  const config = JSON.parse(fs.readFileSync(p, "utf8"));
  const missing = REQUIRED_FIELDS.filter((f) => !(f in config));
  if (missing.length > 0) {
    throw new Error(`asset-config.json 缺字段：${missing.join("、")}`);
  }
  return config;
}

export function writeAssetConfig(projectDir, config) {
  const missing = REQUIRED_FIELDS.filter((f) => !(f in config));
  if (missing.length > 0) {
    throw new Error(`写入 asset-config.json 缺字段：${missing.join("、")}`);
  }
  const p = assetConfigPath(projectDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(config, null, 2) + "\n", "utf8");
}
