import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildAssets } from "../src/lib/buildAssets.mjs";
import { fontForLanguage, readAssetWorkbook } from "../src/lib/assetWorkbook.mjs";
import { validateAssets } from "../src/lib/validateAssets.mjs";
import { RUNTIME_TEMP_ROOT } from "../src/lib/paths.mjs";
import { writeAssetConfig, readAssetConfig } from "../src/lib/assetConfig.mjs";
import { runBuildAndValidate } from "../src/stages/08-build.mjs";
import { internalProjectsDir, loadInternalProjectTerms } from "../src/lib/localTermbase.mjs";

function withIsolatedTermbase(t) {
  fs.mkdirSync(RUNTIME_TEMP_ROOT, { recursive: true });
  const stateDir = fs.mkdtempSync(path.join(RUNTIME_TEMP_ROOT, "transilk-assets-termbase-"));
  const previous = process.env.TRANSILK_TERMBASE_DIR;
  process.env.TRANSILK_TERMBASE_DIR = stateDir;
  t.after(() => {
    if (previous === undefined) delete process.env.TRANSILK_TERMBASE_DIR;
    else process.env.TRANSILK_TERMBASE_DIR = previous;
    fs.rmSync(stateDir, { recursive: true, force: true });
  });
}

function assetFixture(t) {
  fs.mkdirSync(RUNTIME_TEMP_ROOT, { recursive: true });
  const projectDir = fs.mkdtempSync(path.join(RUNTIME_TEMP_ROOT, "transilk-assets-"));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  const config = {
    title: "资产测试",
    date: "2026-08-09",
    sourceFile: "01_原始材料/原文.txt",
    targetFile: "01_原始材料/译文.txt",
    sourceLanguage: "zh-CN",
    targetLanguage: "en-US",
    sourceTermField: "zh_CN",
    targetTermField: "en_US",
    sourceColumnLabel: "中文原文",
    targetColumnLabel: "英文译文",
    languageLabel: "中文-英文",
    segmentPrefix: "AST",
    domain: "信息技术",
    termStem: "资产测试术语库",
    workbookName: "资产测试.xlsx",
    tmxName: "资产测试.tmx",
    expectedSegments: 1,
    glossarySource: "99_项目配置与术语源数据/术语源数据.jsonl",
    documentTitleSegmentNumber: 1,
    headingSegmentNumbers: [],
    defaultTopic: "接口授权",
    sections: [],
  };
  const glossary = [
    {
      id: "T1",
      zh_CN: "访问令牌",
      en_US: "access token",
      status: "首选",
      domain: "信息技术",
      source_segment_id: "AST-0001",
      evidence_source: "web_search",
      evidence_quote: "官方文档采用 access token。",
      evidence_url: "https://example.org/token\nhttps://reference.example/token",
      evidence_verification_level: "cross_checked",
      evidence_sources: [
        { url: "https://example.org/token", title: "Example", excerpt: "access token" },
        { url: "https://reference.example/token", title: "Reference", excerpt: "access token" },
      ],
    },
    {
      id: "T2",
      zh_CN: "OAuth 2.0",
      en_US: "OAuth 2.0",
      status: "首选",
      domain: "信息技术",
      translation_action: "do_not_translate",
      source_segment_id: "AST-0001",
    },
    {
      id: "T3",
      zh_CN: "废弃候选",
      en_US: "rejected candidate",
      status: "弃用",
      domain: "信息技术",
      source_segment_id: "AST-0001",
    },
    {
      id: "T4",
      zh_CN: "项目称谓",
      en_US: "project wording",
      status: "首选",
      domain: "信息技术",
      source_segment_id: "AST-0001",
      evidence_source: "local",
      evidence_local_kind: "project_override",
      evidence_quote: "project wording",
    },
  ];
  const glossaryPath = path.join(projectDir, config.glossarySource);
  fs.mkdirSync(path.dirname(glossaryPath), { recursive: true });
  fs.writeFileSync(glossaryPath, glossary.map((item) => JSON.stringify(item)).join("\n") + "\n", "utf8");
  writeAssetConfig(projectDir, config);
  return { projectDir, config, precomputed: { sourceLines: ["OAuth 2.0 使用访问令牌。"], targetLines: ["OAuth 2.0 uses an access token."] } };
}

test("asset archive publishes only reusable terms with structured provenance", async (t) => {
  const { projectDir, config, precomputed } = assetFixture(t);
  const built = await buildAssets(config, projectDir, precomputed);
  assert.equal(built.glossaryEntries, 2);
  assert.equal(built.exchangeGlossaryEntries, 1);

  const exported = fs.readFileSync(built.jsonl, "utf8").trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(exported.length, 1);
  assert.equal(exported[0].id, "T1");
  assert.equal(exported[0].evidence_verification_level, "cross_checked");
  assert.equal(exported[0].evidence_sources.length, 2);

  const workbook = await readAssetWorkbook(fs.readFileSync(built.xlsxPath));
  const terms = workbook.sheets["术语库"];
  assert.equal(terms.rowCount, 5);
  assert.equal(terms.autoFilter, "A3:P5");
  assert.deepEqual(terms.rows[2].slice(12), ["依据类型", "查证等级", "来源 URL", "查证依据"]);
  assert.equal(terms.rows[3][12], "联网查证");
  assert.equal(terms.rows[3][13], "交叉查证");
  assert.match(terms.rows[3][14], /reference\.example/);
  assert.equal(terms.rows[4][1], "项目称谓");
  assert.equal(terms.rows[4][12], "本地术语库");

  const tbx = fs.readFileSync(built.tbx, "utf8");
  assert.match(tbx, /访问令牌/);
  assert.doesNotMatch(tbx, /OAuth 2\.0|废弃候选|项目称谓/);
  await assert.doesNotReject(() => validateAssets(config, projectDir, precomputed));
});

test("asset validation rejects cross-format terminology drift", async (t) => {
  const { projectDir, config, precomputed } = assetFixture(t);
  const built = await buildAssets(config, projectDir, precomputed);
  const [term] = fs.readFileSync(built.jsonl, "utf8").trim().split(/\r?\n/).map(JSON.parse);
  term.en_US = "tampered term";
  fs.writeFileSync(built.jsonl, JSON.stringify(term) + "\n", "utf8");
  await assert.rejects(() => validateAssets(config, projectDir, precomputed), /JSONL.*en_US 不一致/);
});

test("legacy preferred terms without new metadata remain archivable", async (t) => {
  const { projectDir, config, precomputed } = assetFixture(t);
  const glossaryPath = path.join(projectDir, config.glossarySource);
  fs.writeFileSync(glossaryPath, JSON.stringify({
    id: "LEGACY-1",
    zh_CN: "旧术语",
    en_US: "legacy term",
    source_segment_id: "AST-0001",
  }) + "\n", "utf8");
  const built = await buildAssets(config, projectDir, precomputed);
  const [exported] = fs.readFileSync(built.jsonl, "utf8").trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(exported.status, "首选");
  assert.equal(exported.domain, config.domain);
  await assert.doesNotReject(() => validateAssets(config, projectDir, precomputed));
});

test("asset workbook selects fonts by language", () => {
  assert.equal(fontForLanguage("zh-CN"), "Microsoft YaHei");
  assert.equal(fontForLanguage("ja-JP"), "Yu Gothic");
  assert.equal(fontForLanguage("ko-KR"), "Malgun Gothic");
  assert.equal(fontForLanguage("fr-FR"), "Aptos");
});

test("validated assets sync to the install-relative internal library idempotently", async (t) => {
  withIsolatedTermbase(t);
  const { projectDir, precomputed } = assetFixture(t);
  const first = await runBuildAndValidate(projectDir, precomputed);
  assert.equal(first.termbaseSync.changed, true);
  assert.equal(first.termbaseSync.entries, 1);
  assert.equal(loadInternalProjectTerms().length, 1);
  assert.equal(fs.readdirSync(internalProjectsDir()).length, 1);
  assert.match(readAssetConfig(projectDir).projectId, /^[0-9a-f-]{36}$/);

  const second = await runBuildAndValidate(projectDir, precomputed);
  assert.equal(second.termbaseSync.changed, false);
  assert.equal(fs.readdirSync(internalProjectsDir()).length, 1);
  assert.equal(loadInternalProjectTerms().length, 1);
});

test("asset failure does not create an internal library contribution", async (t) => {
  withIsolatedTermbase(t);
  const { projectDir, config, precomputed } = assetFixture(t);
  writeAssetConfig(projectDir, { ...config, expectedSegments: 2 });
  await assert.rejects(() => runBuildAndValidate(projectDir, precomputed), /句段数量不一致/);
  assert.equal(fs.existsSync(internalProjectsDir()), false);
});
