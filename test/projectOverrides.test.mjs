import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { RUNTIME_TEMP_ROOT } from "../src/lib/paths.mjs";
import {
  applyProjectOverrides,
  ensureProjectOverridesWorkbook,
  projectOverridesPath,
  readProjectOverridesWorkbook,
} from "../src/lib/projectOverrides.mjs";
import { writeSimpleWorkbook } from "../src/lib/xlsx.mjs";
import { checkOverridesAndLocal } from "../src/stages/03-verify.mjs";

const config = {
  sourceLanguage: "en-US",
  targetLanguage: "zh-CN",
  sourceTermField: "en_US",
  targetTermField: "zh_CN",
  domain: "法律",
};

function fixture(t) {
  fs.mkdirSync(RUNTIME_TEMP_ROOT, { recursive: true });
  const projectDir = fs.mkdtempSync(path.join(RUNTIME_TEMP_ROOT, "transilk-project-overrides-"));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  return projectDir;
}

async function writeRows(projectDir, rows, headers = ["原文术语", "指定译文"]) {
  const filePath = projectOverridesPath(projectDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const buffer = await writeSimpleWorkbook({ sheetName: "项目专用译法", headers, rows });
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

test("project override template has only the two fixed columns and is not overwritten", async (t) => {
  const projectDir = fixture(t);
  const filePath = await ensureProjectOverridesWorkbook(projectDir);
  assert.deepEqual(await readProjectOverridesWorkbook(projectDir), []);
  const original = fs.readFileSync(filePath);
  await ensureProjectOverridesWorkbook(projectDir);
  assert.deepEqual(fs.readFileSync(filePath), original);
});

test("project overrides replace extracted targets and add terms missed by extraction", async (t) => {
  const projectDir = fixture(t);
  await writeRows(projectDir, [
    ["party", "当事人"],
    ["court", "法院"],
    ["unused", "未使用"],
  ]);
  const candidates = [{
    id: "CAND-0001",
    sourceTermField: "en_US",
    targetTermField: "zh_CN",
    en_US: "party",
    zh_CN: "党派",
    domain: "法律",
    translation_action: "do_not_translate",
    translation_action_reason: "模型误判为固定写法",
    source_segment_id: "SEG-0001",
  }];
  const segments = [{ id: "SEG-0001", text: "The party appeared before the court." }];
  const result = await applyProjectOverrides(candidates, segments, config, projectDir);

  assert.equal(result.candidates.length, 2);
  assert.equal(result.candidates[0].zh_CN, "当事人");
  assert.equal(result.candidates[0].translation_action, "translate");
  assert.equal(result.candidates[1].en_US, "court");
  assert.equal(result.candidates[1].zh_CN, "法院");
  assert.equal(result.candidates[1].source_segment_id, "SEG-0001");
  assert.equal(result.added, 1);
  assert.deepEqual(result.missing.map((entry) => entry.sourceTerm), ["unused"]);

  const checked = checkOverridesAndLocal(result.candidates, config, projectDir, result.overrides);
  assert.equal(checked.needsWebSearch.length, 0);
  assert.ok(checked.evidence.every((item) => item.source === "local" && item.local_kind === "project_override"));
});

test("project override workbook reports duplicate terms and incomplete rows precisely", async (t) => {
  const projectDir = fixture(t);
  await writeRows(projectDir, [["party", "当事人"], ["", ""], ["party", "参与方"]]);
  await assert.rejects(() => readProjectOverridesWorkbook(projectDir), /第 4 行与第 2 行.*重复/);

  await writeRows(projectDir, [["court", ""]]);
  await assert.rejects(() => readProjectOverridesWorkbook(projectDir), /第 2 行必须同时填写/);
});

test("project override workbook rejects changed headers and conflicting legacy JSON", async (t) => {
  const projectDir = fixture(t);
  await writeRows(projectDir, [["party", "当事人"]], ["源文", "译文"]);
  await assert.rejects(() => readProjectOverridesWorkbook(projectDir), /表头必须为/);

  await writeRows(projectDir, [["party", "当事人"]]);
  const stateDir = path.dirname(projectOverridesPath(projectDir));
  fs.writeFileSync(path.join(stateDir, "overrides.json"), JSON.stringify({ party: "参与方" }), "utf8");
  await assert.rejects(
    () => applyProjectOverrides([], [{ id: "SEG-0001", text: "party" }], config, projectDir),
    /与旧版 overrides\.json 冲突/,
  );
});
