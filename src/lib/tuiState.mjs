import fs from "node:fs";
import path from "node:path";
import { assetConfigPath } from "./assetConfig.mjs";
import { TOOL_ROOT } from "./paths.mjs";
import { targetOutputPath } from "./sourceAdapter.mjs";
import { summarizeEvidence } from "./evidenceSummary.mjs";

export const PROJECTS_ROOT = path.join(TOOL_ROOT, "projects");
const WORK_ROOT = path.join(TOOL_ROOT, "work");

function exists(filePath) {
  return Boolean(filePath && fs.existsSync(filePath));
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readJsonl(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

export function projectSlug(title) {
  const value = String(title ?? "")
    .trim()
    .replace(/[<>:"/\\|?*：\u0000-\u001F]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/[. -]+$/g, "")
    .slice(0, 64);
  return value || "未命名项目";
}

export function projectDirForTitle(title) {
  return path.join(PROJECTS_ROOT, projectSlug(title));
}

export function inspectProject(projectDir) {
  const configPath = assetConfigPath(projectDir);
  const config = readJson(configPath);
  if (!config) return null;

  const name = path.basename(path.resolve(projectDir));
  const workDir = path.join(TOOL_ROOT, "work", name);
  const workbookPath = path.join(workDir, config.workbookName || "候选术语审阅.xlsx");
  const evidencePath = path.join(workDir, "evidence.jsonl");
  const glossaryPath = path.join(projectDir, "99_项目配置与术语源数据", "术语源数据.jsonl");
  const bilingualPath = path.join(workDir, "bilingual.txt");
  const reportPath = path.join(workDir, "check-report.json");
  const targetPath = config.targetFile ? targetOutputPath(config, projectDir) : "";
  const archiveWorkbook = path.join(projectDir, "02_双语对齐工作簿", config.workbookName || "");
  const archiveDir = path.join(projectDir, "03_翻译记忆与术语交换文件");

  const complete = [
    Boolean(config.domain),
    exists(path.join(workDir, "candidates.jsonl")),
    exists(workbookPath),
    exists(glossaryPath),
    exists(bilingualPath),
    exists(targetPath),
    exists(reportPath) && exists(targetPath),
    exists(targetPath),
  ];
  const names = ["文本分析", "术语抽取", "术语查证", "人工确认", "翻译", "译后编辑", "术语核查", "交付"];
  const stages = names.map((stageName, index) => ({
    number: index + 1,
    name: stageName,
    complete: complete[index],
    current: !complete[index] && complete.slice(0, index).every(Boolean),
  }));
  const current = stages.find((stage) => stage.current) ?? stages.at(-1);

  return {
    projectDir,
    name,
    title: config.title || name,
    config,
    workDir,
    evidencePath,
    evidenceSummary: exists(evidencePath) ? summarizeEvidence(readJsonl(evidencePath)) : null,
    workbookPath,
    glossaryPath,
    bilingualPath,
    reportPath,
    targetPath,
    archiveWorkbook,
    archiveDir,
    archived: exists(archiveWorkbook) && exists(archiveDir),
    stages,
    currentLabel: complete.every(Boolean) ? "已完成" : `等待 Stage ${current.number}`,
  };
}

export function listProjects() {
  if (!fs.existsSync(PROJECTS_ROOT)) return [];
  return fs
    .readdirSync(PROJECTS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => inspectProject(path.join(PROJECTS_ROOT, entry.name)))
    .filter(Boolean)
    .sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
}

export function normalizeInputPath(value) {
  const trimmed = String(value ?? "").trim().replace(/^(["'])(.*)\1$/, "$2");
  return trimmed ? path.resolve(trimmed) : "";
}

function safeProjectPath(projectDir, root) {
  const target = path.resolve(projectDir);
  const base = path.resolve(root);
  if (target === base || !target.toLowerCase().startsWith(`${base.toLowerCase()}${path.sep}`)) {
    throw new Error("拒绝删除项目目录之外的路径。");
  }
  return target;
}

export function deleteProject(projectDir) {
  const target = safeProjectPath(projectDir, PROJECTS_ROOT);
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("项目目录不是受支持的普通目录。");
  const workTarget = safeProjectPath(path.join(WORK_ROOT, path.basename(target)), WORK_ROOT);
  if (fs.existsSync(workTarget)) {
    const workStat = fs.lstatSync(workTarget);
    if (workStat.isSymbolicLink()) throw new Error("项目中间产物目录是符号链接，已停止删除。");
  }
  fs.rmSync(target, { recursive: true, force: false });
  if (fs.existsSync(workTarget)) fs.rmSync(workTarget, { recursive: true, force: false });
}
