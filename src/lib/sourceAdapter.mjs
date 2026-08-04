import path from "node:path";
import { loadPlainTextSegments } from "./segment.mjs";
import { readLegacyXlsRows, extractSegmentsFromRows } from "./legacyXls.mjs";
import { ingestRawDocument } from "./rawIngest.mjs";
import { projectSubdir } from "./paths.mjs";

export function configuredProjectPath(projectDir, filePath) {
  if (!filePath) return "";
  return path.isAbsolute(filePath) ? filePath : path.join(projectDir, filePath);
}

export async function resolveSourceSegments(config, projectDir) {
  if (config.sourceFormat === "legacy-xls" || config.sourceFormat === "xlsx") {
    const rows = readLegacyXlsRows(configuredProjectPath(projectDir, config.sourceFile));
    return extractSegmentsFromRows(rows, config.segmentPrefix);
  }
  if (config.sourceFormat === "raw-document") {
    return ingestRawDocument({
      sourcePath: configuredProjectPath(projectDir, config.sourceFile),
      targetPath: configuredProjectPath(projectDir, config.sourceTargetFile),
      segmentPrefix: config.segmentPrefix,
    });
  }
  const sourcePath = path.join(projectSubdir(projectDir, "01_原始材料"), config.sourceFile);
  const segments = loadPlainTextSegments(sourcePath, config.segmentPrefix);
  return { segments, sections: [{ start: 1 }] };
}

export function targetOutputPath(config, projectDir) {
  if (config.sourceFormat === "legacy-xls" || config.sourceFormat === "xlsx" || config.sourceFormat === "raw-document") {
    return path.join(projectDir, config.targetFile);
  }
  return path.join(projectSubdir(projectDir, "01_原始材料"), config.targetFile);
}

export function targetXlsOutputPath(config, projectDir) {
  const extension = path.extname(config.sourceFile).toLowerCase() === ".xlsx" ? ".xlsx" : ".xls";
  const xlsName = config.targetFile.replace(/\.txt$/, extension);
  return path.join(projectDir, xlsName);
}
