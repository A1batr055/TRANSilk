import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  termbasePath,
  loadTermbase,
  buildTermbaseIndex,
  lookupTerm,
  mergeIntoTermbase,
  glossaryToTermbaseEntries,
  parseTbx,
  importTermbaseFromPath,
} from "../src/lib/localTermbase.mjs";
import { checkOverridesAndLocal } from "../src/stages/03-verify.mjs";

function withCleanTermbase(t) {
  const p = termbasePath();
  const backup = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
  if (fs.existsSync(p)) fs.rmSync(p);
  t.after(() => {
    if (backup === null) fs.rmSync(p, { force: true });
    else {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, backup, "utf8");
    }
  });
}

test("mergeIntoTermbase writes entries and lookupTerm finds them by language + term", (t) => {
  withCleanTermbase(t);
  mergeIntoTermbase([
    { sourceLanguage: "zh-CN", targetLanguage: "en-US", sourceTerm: "神经网络", targetTerm: "neural network", domain: "AI" },
  ]);
  const index = buildTermbaseIndex();
  const hits = lookupTerm(index, "zh-CN", "神经网络", "AI");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].targetTerm, "neural network");
  assert.deepEqual(lookupTerm(index, "zh-CN", "不存在", "AI"), []);
});

test("mergeIntoTermbase overwrites within the same domain, keeping the latest value", (t) => {
  withCleanTermbase(t);
  mergeIntoTermbase([{ sourceLanguage: "zh-CN", targetLanguage: "en-US", sourceTerm: "算法", targetTerm: "algorithm", domain: "工程技术" }]);
  mergeIntoTermbase([{ sourceLanguage: "zh-CN", targetLanguage: "en-US", sourceTerm: "算法", targetTerm: "Algorithm", domain: "工程技术" }]);
  const entries = loadTermbase();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].targetTerm, "Algorithm");
});

test("mergeIntoTermbase keeps separate senses for the same term across different domains", (t) => {
  withCleanTermbase(t);
  mergeIntoTermbase([{ sourceLanguage: "zh-CN", targetLanguage: "en-US", sourceTerm: "细胞", targetTerm: "cell", domain: "医学" }]);
  mergeIntoTermbase([{ sourceLanguage: "zh-CN", targetLanguage: "en-US", sourceTerm: "细胞", targetTerm: "battery cell", domain: "工程技术" }]);
  const entries = loadTermbase();
  assert.equal(entries.length, 2);
  const index = buildTermbaseIndex();
  assert.equal(lookupTerm(index, "zh-CN", "细胞", "医学")[0].targetTerm, "cell");
  assert.equal(lookupTerm(index, "zh-CN", "细胞", "工程技术")[0].targetTerm, "battery cell");
  assert.deepEqual(lookupTerm(index, "zh-CN", "细胞", "政务"), []);
});

test("mergeIntoTermbase keeps separate senses for the same term within the same domain", (t) => {
  withCleanTermbase(t);
  mergeIntoTermbase([{ sourceLanguage: "en-US", targetLanguage: "zh-CN", sourceTerm: "party", targetTerm: "当事人", domain: "法律" }]);
  mergeIntoTermbase([{ sourceLanguage: "en-US", targetLanguage: "zh-CN", sourceTerm: "party", targetTerm: "党派", domain: "法律" }]);
  const entries = loadTermbase();
  assert.equal(entries.length, 2);
  const index = buildTermbaseIndex();
  const hits = lookupTerm(index, "en-US", "party", "法律");
  assert.equal(hits.length, 2);
  assert.deepEqual(hits.map((e) => e.targetTerm).sort(), ["当事人", "党派"].sort());

  mergeIntoTermbase([{ sourceLanguage: "en-US", targetLanguage: "zh-CN", sourceTerm: "party", targetTerm: "当事人", domain: "法律", note: "更新释义" }]);
  const updated = lookupTerm(buildTermbaseIndex(), "en-US", "party", "法律");
  assert.equal(updated.length, 2);
  assert.equal(updated.find((e) => e.targetTerm === "当事人").note, "更新释义");
});

test("glossaryToTermbaseEntries drops deprecated entries and maps language fields", () => {
  const config = { sourceLanguage: "zh-CN", targetLanguage: "en-US", domain: "AI", sourceTermField: "zh_CN", targetTermField: "en_US" };
  const glossary = [
    { zh_CN: "模型", en_US: "model", status: "首选" },
    { zh_CN: "废弃词", en_US: "deprecated", status: "弃用" },
  ];
  const entries = glossaryToTermbaseEntries(glossary, config);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].sourceTerm, "模型");
  assert.equal(entries[0].targetTerm, "model");
  assert.equal(entries[0].sourceLanguage, "zh-CN");
});

test("parseTbx reads conceptEntry langSec pairs in both directions", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<tbx type="TBX-Basic" xml:lang="en">
<text>
<body>
  <conceptEntry id="T1">
    <descrip type="subjectField">AI</descrip>
    <descrip type="definition">a term</descrip>
    <langSec xml:lang="zh-CN">
      <termSec>
        <term>神经网络</term>
        <note></note>
      </termSec>
    </langSec>
    <langSec xml:lang="en-US">
      <termSec>
        <term>neural network</term>
      </termSec>
    </langSec>
  </conceptEntry>
</body>
</text>
</tbx>
`;
  const entries = parseTbx(xml);
  assert.equal(entries.length, 2);
  const zhToEn = entries.find((e) => e.sourceLanguage === "zh-CN");
  assert.equal(zhToEn.sourceTerm, "神经网络");
  assert.equal(zhToEn.targetTerm, "neural network");
  assert.equal(zhToEn.domain, "AI");
  assert.equal(zhToEn.definition, "a term");
  const enToZh = entries.find((e) => e.sourceLanguage === "en-US");
  assert.equal(enToZh.sourceTerm, "neural network");
  assert.equal(enToZh.targetTerm, "神经网络");
});

test("importTermbaseFromPath ingests a .tbx file and skips a .tmx file with a reason", (t) => {
  withCleanTermbase(t);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "transilk-termbase-import-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const tbxPath = path.join(tempDir, "sample.tbx");
  fs.writeFileSync(
    tbxPath,
    `<?xml version="1.0" encoding="UTF-8"?>
<tbx type="TBX-Basic" xml:lang="en">
<text>
<body>
  <conceptEntry id="T1">
    <descrip type="subjectField">AI</descrip>
    <descrip type="definition"></descrip>
    <langSec xml:lang="zh-CN">
      <termSec><term>模型</term></termSec>
    </langSec>
    <langSec xml:lang="en-US">
      <termSec><term>model</term></termSec>
    </langSec>
  </conceptEntry>
</body>
</text>
</tbx>
`,
    "utf8"
  );
  const tmxPath = path.join(tempDir, "sample.tmx");
  fs.writeFileSync(tmxPath, `<?xml version="1.0" encoding="UTF-8"?>\n<tmx version="1.4"><body></body></tmx>\n`, "utf8");

  const result = importTermbaseFromPath(tempDir);
  assert.equal(result.imported.length, 1);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].file, tmxPath);
  assert.equal(result.addedOrUpdated, 2);

  const index = buildTermbaseIndex();
  assert.equal(lookupTerm(index, "zh-CN", "模型", "AI")[0].targetTerm, "model");
});

test("checkOverridesAndLocal reports termbase hits with source \"local\" and skips web search", (t) => {
  withCleanTermbase(t);
  mergeIntoTermbase([{ sourceLanguage: "zh-CN", targetLanguage: "en-US", sourceTerm: "术语库", targetTerm: "termbase" }]);
  const config = { sourceLanguage: "zh-CN", targetLanguage: "en-US", sourceTermField: "zh_CN", targetTermField: "en_US" };
  const candidates = [
    { id: "c1", zh_CN: "术语库", en_US: "termbase" },
    { id: "c2", zh_CN: "未知词", en_US: "unknown" },
  ];
  const tempProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), "transilk-verify-test-"));
  t.after(() => fs.rmSync(tempProjectDir, { recursive: true, force: true }));

  const { evidence, needsWebSearch } = checkOverridesAndLocal(candidates, config, tempProjectDir);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].source, "local");
  assert.equal(evidence[0].candidate_id, "c1");
  assert.equal(needsWebSearch.length, 1);
  assert.equal(needsWebSearch[0].id, "c2");
});

test("checkOverridesAndLocal falls back to web/model when the local termbase has multiple senses in the same domain", (t) => {
  withCleanTermbase(t);
  mergeIntoTermbase([
    { sourceLanguage: "en-US", targetLanguage: "zh-CN", sourceTerm: "party", targetTerm: "当事人", domain: "法律" },
    { sourceLanguage: "en-US", targetLanguage: "zh-CN", sourceTerm: "party", targetTerm: "党派", domain: "法律" },
  ]);
  const config = { sourceLanguage: "en-US", targetLanguage: "zh-CN", sourceTermField: "en_US", targetTermField: "zh_CN" };
  const candidates = [{ id: "c1", en_US: "party", zh_CN: "当事人", domain: "法律" }];
  const tempProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), "transilk-verify-test-"));
  t.after(() => fs.rmSync(tempProjectDir, { recursive: true, force: true }));

  const { evidence, needsWebSearch } = checkOverridesAndLocal(candidates, config, tempProjectDir);
  assert.equal(evidence.length, 0);
  assert.equal(needsWebSearch.length, 1);
});

test("checkOverridesAndLocal prefers a domain-scoped override over a plain source-term override", (t) => {
  withCleanTermbase(t);
  const config = { sourceLanguage: "en-US", targetLanguage: "zh-CN", sourceTermField: "en_US", targetTermField: "zh_CN" };
  const candidates = [
    { id: "c1", en_US: "party", zh_CN: "", domain: "法律" },
    { id: "c2", en_US: "party", zh_CN: "", domain: "政务" },
  ];
  const tempProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), "transilk-verify-test-"));
  t.after(() => fs.rmSync(tempProjectDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(tempProjectDir, "99_项目配置与术语源数据"), { recursive: true });
  fs.writeFileSync(
    path.join(tempProjectDir, "99_项目配置与术语源数据", "overrides.json"),
    JSON.stringify({ party: "当事人", "party::政务": "党派" }),
    "utf8"
  );

  const { evidence } = checkOverridesAndLocal(candidates, config, tempProjectDir);
  assert.equal(evidence.find((e) => e.candidate_id === "c1").quote, "当事人");
  assert.equal(evidence.find((e) => e.candidate_id === "c2").quote, "党派");
});
