import fs from "node:fs";
import path from "node:path";
import { segmentId } from "./segment.mjs";
import { projectSubdir } from "./paths.mjs";
import { writeAssetWorkbook } from "./assetWorkbook.mjs";
import { termFields, reusableGlossaryTerms } from "./language.mjs";


function escXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function topicFor(number, config) {
  const sections = config.sections ?? [];
  const applicable = sections.filter((sec) => sec.start <= number);
  if (applicable.length === 0) return config.defaultTopic;
  return applicable[applicable.length - 1].topic;
}

function readLines(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function buildPairs(sourceLines, targetLines, config) {
  const { sourceField, targetField } = termFields(config);
  return sourceLines.map((source, i) => {
    const number = i + 1;
    const target = targetLines[i];
    const type =
      number === config.documentTitleSegmentNumber
        ? "文档标题"
        : (config.headingSegmentNumbers ?? []).includes(number)
        ? "小节标题"
        : "正文";
    return {
      id: segmentId(config.segmentPrefix, number),
      number,
      type,
      topic: topicFor(number, config),
      source,
      target,
      [sourceField]: source,
      [targetField]: target,
    };
  });
}

function buildTmx(pairs, config) {
  const units = pairs
    .map(
      (p) => `  <tu>
    <prop type="x-segment-type">${escXml(p.type)}</prop>
    <prop type="x-topic">${escXml(p.topic)}</prop>
    <tuv xml:lang="${escXml(config.sourceLanguage)}"><seg>${escXml(p.source)}</seg></tuv>
    <tuv xml:lang="${escXml(config.targetLanguage)}"><seg>${escXml(p.target)}</seg></tuv>
  </tu>`
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<tmx version="1.4">
<header creationtool="TRANSilk" creationtoolversion="1.0" datatype="plaintext" segtype="sentence" adminlang="en-US" srclang="${escXml(config.sourceLanguage)}" o-tmf="TRANSilk"/>
<body>
${units}
</body>
</tmx>
`;
}

function buildTbx(glossary, config) {
  const { sourceField, targetField } = termFields(config);
  const entries = glossary
    .map((g) => {
      const evidence = g.evidence_quote
        ? `\n    <note>[${escXml(g.evidence_source)}] ${escXml(g.evidence_quote)}</note>`
        : "";
      const evidenceUrls = (g.evidence_sources ?? [])
        .map((source) => source?.url)
        .filter(Boolean)
        .join(" | ") || g.evidence_url || "";
      const evidenceRefs = evidenceUrls
        ? `\n    <note>来源：${escXml(evidenceUrls)}</note>`
        : "";
      const variants = (g[`${targetField}_variants`] ?? g.en_variants ?? [])
        .map((v) => `\n        <termNote type="variant">${escXml(v)}</termNote>`)
        .join("");
      return `  <conceptEntry id="${escXml(g.id)}">
    <descrip type="subjectField">${escXml(g.domain || config.domain || "")}</descrip>
    <descrip type="definition">${escXml(g.definition || g.definition_zh || "")}</descrip>${evidence}${evidenceRefs}
    <langSec xml:lang="${escXml(config.sourceLanguage)}">
      <termSec>
        <term>${escXml(g[sourceField])}</term>
        <note>${escXml(g.note || g.note_zh || "")}</note>
      </termSec>
    </langSec>
    <langSec xml:lang="${escXml(config.targetLanguage)}">
      <termSec>
        <term>${escXml(g[targetField])}</term>${variants}
      </termSec>
    </langSec>
  </conceptEntry>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<tbx type="TBX-Basic" xml:lang="en">
<text>
<body>
${entries}
</body>
</text>
</tbx>
`;
}

export async function buildAssets(config, projectDir, precomputed) {
  const mainDir = projectSubdir(projectDir, "02_双语对齐工作簿");
  const exchangeDir = projectSubdir(projectDir, "03_翻译记忆与术语交换文件");
  const stateDir = projectSubdir(projectDir, "99_项目配置与术语源数据");
  for (const dir of [mainDir, exchangeDir, stateDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

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
  if (config.expectedSegments && sourceLines.length !== config.expectedSegments) {
    throw new Error(
      `句段数量不一致：实际为 ${sourceLines.length}，asset-config.json 中的 expectedSegments 为 ${config.expectedSegments}`
    );
  }
  const pairs = buildPairs(sourceLines, targetLines, config);
  const pairsById = new Map(pairs.map((p) => [p.id, p]));

  const glossaryPath = path.join(projectDir, config.glossarySource);
  const glossaryRaw = fs.existsSync(glossaryPath)
    ? fs
        .readFileSync(glossaryPath, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
  const { sourceField, targetField } = termFields(config);
  const glossary = reusableGlossaryTerms(
    glossaryRaw.map((g) => {
      const pair = pairsById.get(g.source_segment_id);
      return {
        ...g,
        status: g.status || "首选",
        domain: g.domain || config.domain || "",
        en_variants: g.en_variants ?? [],
        [`${targetField}_variants`]: g[`${targetField}_variants`] ?? g.en_variants ?? [],
        context_source: pair?.[sourceField] ?? "",
        context_target: pair?.[targetField] ?? "",
        context_zh: pair?.zh_CN ?? g.context_zh ?? "",
        context_en: pair?.en_US ?? g.context_en ?? "",
        source_title: config.title,
        created_on: config.date,
      };
    }),
    config
  );
  const seenIds = new Set();
  for (const g of glossary) {
    if (seenIds.has(g.id)) throw new Error(`术语ID重复：${g.id}`);
    seenIds.add(g.id);
  }

  const tmxPath = path.join(exchangeDir, config.tmxName);
  fs.writeFileSync(tmxPath, buildTmx(pairs, config), "utf8");

  const tbxPath = path.join(exchangeDir, `${config.termStem}.tbx`);
  fs.writeFileSync(tbxPath, buildTbx(glossary, config), "utf8");

  const jsonlPath = path.join(exchangeDir, `${config.termStem}.jsonl`);
  fs.writeFileSync(
    jsonlPath,
    glossary.map((g) => JSON.stringify(g)).join("\n") + (glossary.length ? "\n" : ""),
    "utf8"
  );

  const workbookPath = path.join(mainDir, config.workbookName);
  await writeAssetWorkbook({
    filePath: workbookPath,
    title: config.title,
    domain: config.domain,
    label: config.languageLabel,
    pairs,
    glossary,
    sourceColumnLabel: config.sourceColumnLabel,
    targetColumnLabel: config.targetColumnLabel,
    sourceLanguage: config.sourceLanguage,
    targetLanguage: config.targetLanguage,
  });

  return {
    projectRoot: projectDir,
    xlsxPath: workbookPath,
    alignmentUnits: pairs.length,
    glossaryEntries: glossary.length,
    tmx: tmxPath,
    tbx: tbxPath,
    jsonl: jsonlPath,
  };
}
