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
  const hit = lookupTerm(index, "zh-CN", "神经网络");
  assert.equal(hit.targetTerm, "neural network");
  assert.equal(lookupTerm(index, "zh-CN", "不存在"), null);
});

test("mergeIntoTermbase dedupes by source language + term, keeping the latest value", (t) => {
  withCleanTermbase(t);
  mergeIntoTermbase([{ sourceLanguage: "zh-CN", targetLanguage: "en-US", sourceTerm: "算法", targetTerm: "algorithm" }]);
  mergeIntoTermbase([{ sourceLanguage: "zh-CN", targetLanguage: "en-US", sourceTerm: "算法", targetTerm: "Algorithm" }]);
  const entries = loadTermbase();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].targetTerm, "Algorithm");
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
  assert.equal(lookupTerm(index, "zh-CN", "模型").targetTerm, "model");
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
