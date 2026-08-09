#!/usr/bin/env node
import path from "node:path";
import { readAssetConfig, writeAssetConfig, assetConfigPath } from "./lib/assetConfig.mjs";
import { workDirFor, projectSubdir } from "./lib/paths.mjs";
import { bootstrapFromLegacyXls, bootstrapFromRawDocument } from "./lib/bootstrapProject.mjs";
import { assertSegmentCount } from "./lib/segment.mjs";
import { configuredProjectPath, resolveSourceSegments, targetOutputPath, targetXlsOutputPath } from "./lib/sourceAdapter.mjs";
import { writeLegacyXlsTranslations } from "./lib/legacyXls.mjs";
import { analyzeText } from "./stages/01-analyze.mjs";
import { extractCandidates } from "./stages/02-extract.mjs";
import { verifyCandidates } from "./stages/03-verify.mjs";
import { exportCandidatesToWorkbook, importReviewedGlossary } from "./stages/04-freeze.mjs";
import { translateWithGlossary } from "./stages/05-translate.mjs";
import { importTermbaseFromPath, listMountedTermbases, unmountExternalTermbase } from "./lib/localTermbase.mjs";
import { loadPendingDomains, addDomain, recordPendingDomain, listDomainLabels, PENDING_DOMAIN_LABEL } from "./lib/domainTaxonomy.mjs";
import { checkForUpdates } from "./lib/selfUpdate.mjs";
import { runBuildAndValidate } from "./stages/08-build.mjs";
import { checkRealization, writeCheckReport } from "./stages/07-check.mjs";
import { parseBilingualTxt, writeBilingualTxt, assertIdSetMatches } from "./lib/bilingual.mjs";
import fs from "node:fs";
import { launchTui } from "./tui.mjs";
import { fileURLToPath } from "node:url";
import { formatEvidenceSummary, summarizeEvidence } from "./lib/evidenceSummary.mjs";

const [, , command, ...rest] = process.argv;

const USAGE =
  "用法：\n" +
  "  transilk bootstrap <项目目录> <原始材料路径> <segmentPrefix> [title] [date=YYYY-MM-DD] --direction <源语->目标语> [--target <既有译文路径>]\n" +
  "    原始材料路径支持 .xls/.xlsx（三列表格）、.doc/.docx/.txt/.md（未预先切段的原文）\n" +
  "    --target 仅用于文档类材料：按段落对齐既有译文，不给则自动切句、留空译文\n" +
  "  transilk prep      <项目目录>   # Stages 1–3 → 术语审阅 Excel，停\n" +
  "  transilk translate <项目目录>   # Stages 4–5 → 双语对照 txt，停\n" +
  "  transilk finish    <项目目录>   # Stages 7–8 → 核查 + 落库交付译文\n" +
  "  transilk archive   <项目目录>   # 可选：生成双语对齐工作簿 + TMX/TBX/JSONL（积累个人资产）\n" +
  "  transilk mount-termbase <TBX文件或目录>   # 手动挂载外部术语库，供 Stage 3 本地命中\n" +
  "  transilk list-termbases   # 查看已挂载的外部术语库\n" +
  "  transilk unmount-termbase <挂载ID或路径>   # 移除外部术语库挂载\n" +
  "  transilk list-pending-domains   # 查看 Stage 1 归不进封闭词表、待人工确认的领域建议\n" +
  "  transilk add-domain <领域名>   # 把领域名加入封闭词表\n" +
  "  transilk reclassify-domain <项目目录> <新领域名>   # 把已有项目的 domain 改成封闭词表内的值\n" +
  "  transilk check-update   # 检查并拉取上游更新（仅在可快进合并时才会更新）";

const COMMANDS = {
  bootstrap: runBootstrap,
  prep: runPrep,
  translate: runTranslate,
  finish: runFinish,
  archive: runArchive,
  "mount-termbase": runMountTermbase,
  "import-termbase": runMountTermbase,
  "list-termbases": runListTermbases,
  "unmount-termbase": runUnmountTermbase,
  "list-pending-domains": runListPendingDomains,
  "add-domain": runAddDomain,
  "reclassify-domain": runReclassifyDomain,
  "check-update": runCheckUpdate,
};

async function main() {
  if (command === "version" || command === "--version" || command === "-v") {
    const packagePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const packageInfo = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    console.log(`TRANSilk ${packageInfo.version}`);
    return;
  }
  if (!command) {
    if (process.stdin.isTTY && process.stdout.isTTY) {
      await launchTui();
    } else {
      console.error(USAGE);
      process.exitCode = 1;
    }
    return;
  }

  if (!COMMANDS[command]) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  if (command === "bootstrap") {
    const targetFlagIndex = rest.indexOf("--target");
    const targetPathArg = targetFlagIndex >= 0 ? rest[targetFlagIndex + 1] : undefined;
    const directionFlagIndex = rest.indexOf("--direction");
    const directionArg = directionFlagIndex >= 0 ? rest[directionFlagIndex + 1] : undefined;
    const optionIndexes = [targetFlagIndex, directionFlagIndex].filter((index) => index >= 0);
    const firstOptionIndex = optionIndexes.length ? Math.min(...optionIndexes) : rest.length;
    const positional = rest.slice(0, firstOptionIndex);

    const [projectDirArg, sourcePath, segmentPrefix, title, date] = positional;
    if (!projectDirArg || !sourcePath || !segmentPrefix) {
      console.error(USAGE);
      process.exitCode = 1;
      return;
    }
    await runBootstrap(
      path.resolve(projectDirArg),
      path.resolve(sourcePath),
      segmentPrefix,
      title,
      date,
      targetPathArg ? path.resolve(targetPathArg) : undefined,
      directionArg,
    );
    return;
  }

  if (command === "list-pending-domains") {
    await runListPendingDomains();
    return;
  }

  if (command === "add-domain") {
    const [label] = rest;
    if (!label) {
      console.error(USAGE);
      process.exitCode = 1;
      return;
    }
    await runAddDomain(label);
    return;
  }

  if (command === "check-update") {
    await runCheckUpdate();
    return;
  }

  if (command === "reclassify-domain") {
    const [projectDirArg, newLabel] = rest;
    if (!projectDirArg || !newLabel) {
      console.error(USAGE);
      process.exitCode = 1;
      return;
    }
    await runReclassifyDomain(path.resolve(projectDirArg), newLabel);
    return;
  }

  const [projectDirArg] = rest;
  if (!projectDirArg) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  await COMMANDS[command](path.resolve(projectDirArg));
}

async function runBootstrap(projectDir, sourcePath, segmentPrefix, title, date, targetPath, direction) {
  const resolvedTitle = title || path.basename(projectDir);
  const resolvedDate = date || new Date().toISOString().slice(0, 10);
  const ext = path.extname(sourcePath).toLowerCase();

  const { segments } =
    ext === ".xls" || ext === ".xlsx"
      ? bootstrapFromLegacyXls({
          xlsPath: sourcePath,
          projectDir,
          title: resolvedTitle,
          segmentPrefix,
          date: resolvedDate,
          direction,
        })
      : await bootstrapFromRawDocument({
          sourcePath,
          targetPath,
          projectDir,
          title: resolvedTitle,
          segmentPrefix,
          date: resolvedDate,
          direction,
        });
  console.log(`bootstrap完成：${segments.length} 句段，asset-config.json 已写入 ${assetConfigPath(projectDir)}`);
  console.log("接下来执行 prep 命令继续 Stages 1–3。");
}

async function runPrep(projectDir) {
  const config = readAssetConfig(projectDir);
  const workDir = workDirFor(projectDir);
  const { segments, sections } = await resolveSourceSegments(config, projectDir);
  assertSegmentCount(segments, config.expectedSegments);
  fs.writeFileSync(
    path.join(workDir, "segments.json"),
    JSON.stringify({ segments, rawSections: sections }, null, 2),
    "utf8"
  );

  const analyzed = await analyzeText(segments, sections, config);
  writeAssetConfig(projectDir, analyzed);
  if (analyzed.domain === PENDING_DOMAIN_LABEL) {
    recordPendingDomain(analyzed.domainSuggestion, { title: analyzed.title, date: analyzed.date });
    console.log(`Stage 1 完成：domain=${analyzed.domain}（模型建议"${analyzed.domainSuggestion}"，已记录待归类，可用 add-domain 转正），defaultTopic=${analyzed.defaultTopic}`);
  } else {
    console.log(`Stage 1 完成：domain=${analyzed.domain}，defaultTopic=${analyzed.defaultTopic}`);
  }

  const candidates = await extractCandidates(segments, analyzed);
  fs.writeFileSync(
    path.join(workDir, "candidates.jsonl"),
    candidates.map((c) => JSON.stringify(c)).join("\n") + "\n",
    "utf8"
  );
  const doNotTranslateCount = candidates.filter((candidate) => candidate.translation_action === "do_not_translate").length;
  console.log(`Stage 2 完成：候选术语 ${candidates.length} 条｜不译 ${doNotTranslateCount}｜待查证 ${candidates.length - doNotTranslateCount}`);

  const evidence = await verifyCandidates(candidates, analyzed, projectDir, {
    onProgress(progress) {
      if (progress.step === "do_not_translate") {
        console.log(`Stage 3/不译：跳过查证 ${progress.found}`);
      }
      if (progress.step === "local") {
        console.log(`Stage 3/本地术语库：命中 ${progress.found}｜进入联网查证 ${progress.remaining}`);
      }
      if (progress.step === "web_started" && progress.total > 0) {
        console.log(`Stage 3/联网查证：正在处理 ${progress.total} 条……`);
      }
      if (progress.step === "web") {
        console.log(`Stage 3/联网查证：查到 ${progress.found}｜未检出 ${progress.notFound}｜失败 ${progress.error}`);
      }
      if (progress.step === "model_knowledge") {
        console.log(`Stage 3/模型知识：处理 ${progress.found}`);
      }
    },
  });
  fs.writeFileSync(
    path.join(workDir, "evidence.jsonl"),
    evidence.map((e) => JSON.stringify(e)).join("\n") + "\n",
    "utf8"
  );
  const evidenceSummary = summarizeEvidence(evidence);
  console.log(`Stage 3 完成：${formatEvidenceSummary(evidenceSummary)}`);
  if (evidenceSummary.modelKnowledge > 0) {
    console.log(`模型知识入口：联网未检出 ${evidenceSummary.webNotFound}｜联网失败 ${evidenceSummary.webError}`);
  }

  const workbookPath = path.join(workDir, analyzed.workbookName || "候选术语审阅.xlsx");
  await exportCandidatesToWorkbook(candidates, evidence, workbookPath, analyzed);
  console.log(`候选术语审阅表已导出：${workbookPath}`);
  console.log(`请修改「${analyzed.targetLabel || analyzed.targetLanguage}译法」，或在「删除」列选择「删除」；存盘后返回 TRANSilk 继续。`);
}

async function runTranslate(projectDir) {
  const config = readAssetConfig(projectDir);
  const workDir = workDirFor(projectDir);
  const workbookPath = path.join(workDir, config.workbookName || "候选术语审阅.xlsx");
  if (!fs.existsSync(workbookPath)) {
    throw new Error(`没找到术语审阅表，先跑 prep：${workbookPath}`);
  }

  const candidates = fs
    .readFileSync(path.join(workDir, "candidates.jsonl"), "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const evidence = fs
    .readFileSync(path.join(workDir, "evidence.jsonl"), "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const glossary = await importReviewedGlossary(workbookPath, candidates, evidence);
  const glossaryPath = path.join(projectSubdir(projectDir, "99_项目配置与术语源数据"), "术语源数据.jsonl");
  fs.mkdirSync(path.dirname(glossaryPath), { recursive: true });
  fs.writeFileSync(glossaryPath, glossary.map((g) => JSON.stringify(g)).join("\n") + "\n", "utf8");
  console.log(`Stage 4 完成：术语表已冻结，${glossary.length} 条，写入 ${glossaryPath}`);

  const { segments } = JSON.parse(fs.readFileSync(path.join(workDir, "segments.json"), "utf8"));
  const translated = await translateWithGlossary(segments, glossary, config);
  const bilingualPath = path.join(workDir, "bilingual.txt");
  fs.writeFileSync(bilingualPath, writeBilingualTxt(translated), "utf8");
  console.log(`Stage 5 完成：双语对照 txt 已写入 ${bilingualPath}，请直接在这份 txt 上做PE，改完执行 finish 命令继续。`);
}

async function runFinish(projectDir) {
  const config = readAssetConfig(projectDir);
  const workDir = workDirFor(projectDir);
  const bilingualPath = path.join(workDir, "bilingual.txt");
  if (!fs.existsSync(bilingualPath)) {
    throw new Error(`没找到 PE 后的双语对照 txt：${bilingualPath}`);
  }
  const segments = parseBilingualTxt(fs.readFileSync(bilingualPath, "utf8"));
  const { segments: sourceSegments } = await resolveSourceSegments(config, projectDir);
  assertIdSetMatches(segments, sourceSegments.map((s) => s.id));

  const glossaryPath = path.join(projectSubdir(projectDir, "99_项目配置与术语源数据"), "术语源数据.jsonl");
  const glossary = fs
    .readFileSync(glossaryPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const report = checkRealization(glossary, segments, config);
  const reportPath = writeCheckReport(workDir, report);

  // 核查只告警；Agent 不得据此阻断人工裁决后的交付。
  if (report.length > 0) {
    console.log(`落实核查发现 ${report.length} 处术语未落地，详见 ${reportPath}，人工确认后继续。`);
  } else {
    console.log("落实核查通过，术语全部落地。");
  }

  const targetPath = targetOutputPath(config, projectDir);
  fs.writeFileSync(targetPath, segments.map((s) => s.target).join("\n") + "\n", "utf8");

  if (config.sourceFormat === "legacy-xls" || config.sourceFormat === "xlsx") {
    const targetById = new Map(segments.map((s) => [s.id, s.target]));
    const rowTexts = sourceSegments
      .filter((s) => targetById.has(s.id))
      .map((s) => ({ row: s.excelRow, text: targetById.get(s.id) }));
    const xlsOutPath = targetXlsOutputPath(config, projectDir);
    writeLegacyXlsTranslations(configuredProjectPath(projectDir, config.sourceFile), xlsOutPath, rowTexts);
    console.log(`译文已写入 ${targetPath}（纯文本版）和 ${xlsOutPath}（原表格式，不改原文件）。`);
    console.log("如需积累双语对齐工作簿 + TM/术语资产包，执行 archive 命令（可选）。");
    return;
  }

  if (config.sourceFormat === "raw-document") {
    console.log(`译文已写入 ${targetPath}。`);
    console.log("如需积累双语对齐工作簿 + TM/术语资产包，执行 archive 命令（可选）。");
    return;
  }
  const built = await runBuildAndValidate(projectDir);
  console.log(`已自动同步 ${built.termbaseSync.entries} 条术语至 TRANSilk 内部库。`);
}

async function runArchive(projectDir) {
  const config = readAssetConfig(projectDir);
  const workDir = workDirFor(projectDir);
  const bilingualPath = path.join(workDir, "bilingual.txt");

  let precomputed;
  if (fs.existsSync(bilingualPath)) {
    const peSegments = parseBilingualTxt(fs.readFileSync(bilingualPath, "utf8"));
    const { segments: sourceSegments } = await resolveSourceSegments(config, projectDir);
    assertIdSetMatches(peSegments, sourceSegments.map((s) => s.id));
    const targetById = new Map(peSegments.map((s) => [s.id, s.target]));
    const ordered = [...sourceSegments].sort((a, b) => a.index - b.index);
    precomputed = {
      sourceLines: ordered.map((s) => s.text),
      targetLines: ordered.map((s) => targetById.get(s.id)),
    };
  } else if (config.sourceFormat === "legacy-xls" || config.sourceFormat === "xlsx" || config.sourceFormat === "raw-document") {
    throw new Error(`没找到 PE 后的双语对照 txt，先跑 translate：${bilingualPath}`);
  }

  const built = await runBuildAndValidate(projectDir, precomputed);
  console.log(`积累完成：工作簿 ${built.xlsxPath}`);
  console.log(`TMX/TBX/JSONL 已生成于 03_翻译记忆与术语交换文件（${built.alignmentUnits} 个句段，${built.glossaryEntries} 条术语）。`);
  console.log(`${built.termbaseSync.changed ? "已同步" : "无需重复同步"} ${built.termbaseSync.entries} 条术语至 TRANSilk 内部库。`);
}

async function runMountTermbase(inputPath) {
  if (!inputPath) throw new Error("请提供 TBX 文件或目录路径。");
  const result = importTermbaseFromPath(inputPath);
  for (const item of result.imported) {
    console.log(`${item.updated ? "已刷新" : "已挂载"} ${item.file}：${item.count} 条术语`);
  }
  for (const item of result.skipped) {
    console.log(`跳过 ${item.file}：${item.reason}`);
  }
  console.log(`外部术语库挂载完成：当前共 ${result.totalMounts} 个挂载。`);
}

async function runListTermbases() {
  const mounts = listMountedTermbases();
  if (!mounts.length) {
    console.log("当前没有已挂载的外部术语库。");
    return;
  }
  for (const mount of mounts) {
    console.log(`${mount.id}｜${mount.available ? "可用" : "文件缺失"}｜${mount.name}｜${mount.path}`);
  }
}

async function runUnmountTermbase(identifier) {
  if (!identifier) throw new Error("请提供外部术语库的挂载 ID 或路径。");
  const result = unmountExternalTermbase(identifier);
  if (!result.removed) throw new Error(`未找到外部术语库挂载：${identifier}`);
  console.log(`已移除外部术语库挂载：${result.removed.name}`);
}

async function runListPendingDomains() {
  const pending = loadPendingDomains();
  if (pending.length === 0) {
    console.log("暂无待归类领域记录。");
    return;
  }
  for (const p of pending) {
    console.log(`[${p.date}] ${p.title}：${p.suggestion}`);
  }
}

async function runAddDomain(label) {
  const total = addDomain(label);
  console.log(`已加入封闭词表："${label}"（当前共 ${total} 项）。`);
}

async function runReclassifyDomain(projectDir, newLabel) {
  const trimmed = String(newLabel ?? "").trim();
  if (!listDomainLabels().includes(trimmed)) {
    throw new Error(`"${trimmed}"不在封闭词表内，请先用 add-domain 加入`);
  }
  const config = readAssetConfig(projectDir);
  const oldDomain = config.domain;
  config.domain = trimmed;
  writeAssetConfig(projectDir, config);
  console.log(`已将 ${path.basename(projectDir)} 的 domain 从"${oldDomain}"改为"${trimmed}"。`);
}

async function runCheckUpdate() {
  try {
    const result = await checkForUpdates();
    console.log(result.message);
    if (result.status === "diverged") process.exitCode = 1;
  } catch (error) {
    console.error(`检查更新失败：${error.message}，可手动执行 git pull 重试`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
