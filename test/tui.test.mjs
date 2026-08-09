import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { App, ConfigWizard, DomainPendingEditScreen, DomainTaxonomyScreen, ExternalTermbasesScreen, ModelSettingsScreen, ModelSwitch, OtherSettingsScreen, ProjectList, ProjectView, TerminologySettingsScreen } from "../src/tui.mjs";
import { listAvailableModels } from "../src/lib/modelCatalog.mjs";
import { inspectProject, normalizeInputPath, projectSlug } from "../src/lib/tuiState.mjs";
import { detectDirection, resolveLanguageProfile, termFields } from "../src/lib/language.mjs";
import { extractCandidates } from "../src/stages/02-extract.mjs";
import { translateWithGlossary } from "../src/stages/05-translate.mjs";
import { reviewHeaders } from "../src/stages/04-freeze.mjs";
import { checkRealization } from "../src/stages/07-check.mjs";
import { bootstrapFromRawDocument } from "../src/lib/bootstrapProject.mjs";
import { resolveSourceSegments, targetXlsOutputPath } from "../src/lib/sourceAdapter.mjs";
import { readDocumentParagraphs } from "../src/lib/docReader.mjs";
import { RUNTIME_TEMP_ROOT } from "../src/lib/paths.mjs";
import { projectOverridesPath, readProjectOverridesWorkbook } from "../src/lib/projectOverrides.mjs";
import { autoCheckForUpdates } from "../src/lib/selfUpdate.mjs";

const appProps = { initialScreen: "home", initialModel: { configured: true, label: "测试模型" } };

test("projectSlug creates a Windows-safe project folder name", () => {
  assert.equal(projectSlug("  Dogfood：术语 / 测试  "), "Dogfood-术语-测试");
  assert.equal(projectSlug("<>:\"/\\|?*"), "未命名项目");
});

test("normalizeInputPath accepts a dragged quoted path", () => {
  const value = normalizeInputPath('"projects\\sample\\source.txt"');
  assert.ok(value.endsWith("projects\\sample\\source.txt"));
});

test("new projects copy source material into 01 before processing", async (t) => {
  const tempRoot = RUNTIME_TEMP_ROOT;
  fs.mkdirSync(tempRoot, { recursive: true });
  const projectDir = fs.mkdtempSync(path.join(tempRoot, "transilk-material-test-"));
  const sourcePath = path.join(projectDir, "..", `${path.basename(projectDir)}-source.txt`);
  const workDir = path.join(process.cwd(), "work", path.basename(projectDir));
  fs.writeFileSync(sourcePath, "A source sentence.\n", "utf8");
  t.after(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(sourcePath, { force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  const { config } = await bootstrapFromRawDocument({
    sourcePath,
    projectDir,
    title: "材料复制测试",
    segmentPrefix: "SEG",
    date: "2026-08-04",
    direction: "en-zh",
  });
  const copiedPath = path.join(projectDir, config.sourceFile);
  assert.match(config.sourceFile, /^01_原始材料[\\/]/);
  assert.equal(fs.readFileSync(copiedPath, "utf8"), "A source sentence.\n");
  assert.match(config.targetFile, /^01_原始材料[\\/]/);
  assert.match(config.projectId, /^[0-9a-f-]{36}$/);
  assert.ok(fs.existsSync(projectOverridesPath(projectDir)));
  assert.deepEqual(await readProjectOverridesWorkbook(projectDir), []);
  const resolved = await resolveSourceSegments(config, projectDir);
  assert.equal(resolved.segments[0].text, "A source sentence.");
  assert.equal(fs.readFileSync(sourcePath, "utf8"), "A source sentence.\n");
});

test("delivery path never overwrites a copied input with the same name", async (t) => {
  const tempRoot = RUNTIME_TEMP_ROOT;
  fs.mkdirSync(tempRoot, { recursive: true });
  const projectDir = fs.mkdtempSync(path.join(tempRoot, "transilk-collision-test-"));
  const inputDir = fs.mkdtempSync(path.join(tempRoot, "transilk-collision-input-"));
  const sourcePath = path.join(inputDir, "同名测试_译文.txt");
  const workDir = path.join(process.cwd(), "work", path.basename(projectDir));
  fs.writeFileSync(sourcePath, "Original source.\n", "utf8");
  t.after(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(inputDir, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  });
  const { config } = await bootstrapFromRawDocument({
    sourcePath,
    projectDir,
    title: "同名测试",
    segmentPrefix: "SEG",
    date: "2026-08-04",
    direction: "en-zh",
  });
  assert.equal(path.basename(config.targetFile), "交付_同名测试_译文.txt");
  assert.equal(fs.readFileSync(path.join(projectDir, config.sourceFile), "utf8"), "Original source.\n");
});

test("Markdown is accepted as a plain-text source document", async (t) => {
  const tempRoot = RUNTIME_TEMP_ROOT;
  fs.mkdirSync(tempRoot, { recursive: true });
  const inputDir = fs.mkdtempSync(path.join(tempRoot, "transilk-md-test-"));
  const sourcePath = path.join(inputDir, "source.md");
  fs.writeFileSync(sourcePath, "# Heading\n\nA Markdown paragraph.\n", "utf8");
  t.after(() => fs.rmSync(inputDir, { recursive: true, force: true }));
  assert.deepEqual(await readDocumentParagraphs(sourcePath), ["# Heading", "A Markdown paragraph."]);
});

test("XLSX projects preserve the XLSX delivery extension", () => {
  const output = targetXlsOutputPath({
    sourceFile: "01_原始材料/source.xlsx",
    targetFile: "01_原始材料/target.txt",
  }, path.join(RUNTIME_TEMP_ROOT, "project"));
  assert.equal(path.extname(output), ".xlsx");
});

test("TUI opens the create-project wizard from the home screen", async () => {
  const view = render(React.createElement(App, appProps));
  assert.match(view.lastFrame(), /TRANSilk/);
  assert.match(view.lastFrame(), /新建翻译项目/);
  assert.match(view.lastFrame(), /项目列表/);
  assert.match(view.lastFrame(), /模型设置/);
  assert.match(view.lastFrame(), /其他设置/);
  assert.doesNotMatch(view.lastFrame(), /外部术语库/);
  assert.doesNotMatch(view.lastFrame(), /清空本地 API 配置/);
  assert.doesNotMatch(view.lastFrame(), /检查并安装更新/);
  view.stdin.write("\r");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(view.lastFrame(), /原始材料路径/);
  view.unmount();
});

test("TUI groups model, terminology, and maintenance actions below the home screen", () => {
  const model = render(React.createElement(ModelSettingsScreen, {
    model: { configured: true, label: "测试模型" },
    notice: null,
    onSelectModel() {},
    onConfigure() {},
    onClearConfig() {},
    onBack() {},
  }));
  assert.match(model.lastFrame(), /选择模型  ·  测试模型/);
  assert.match(model.lastFrame(), /配置服务商 \/ API Key/);
  assert.match(model.lastFrame(), /清空本地 API 配置/);
  model.unmount();

  const other = render(React.createElement(OtherSettingsScreen, {
    notice: null,
    onTerminology() {},
    onCheckUpdate() {},
    onExit() {},
    onBack() {},
  }));
  assert.match(other.lastFrame(), /术语与领域/);
  assert.match(other.lastFrame(), /检查并安装更新/);
  assert.match(other.lastFrame(), /退出 TRANSilk/);
  assert.doesNotMatch(other.lastFrame(), /外部术语库/);
  other.unmount();

  const terminology = render(React.createElement(TerminologySettingsScreen, {
    termbaseCount: 2,
    onExternalTermbases() {},
    onDomainTaxonomy() {},
    onBack() {},
  }));
  assert.match(terminology.lastFrame(), /外部术语库  ·  2 个挂载/);
  assert.match(terminology.lastFrame(), /领域词表管理/);
  terminology.unmount();
});

test("automatic update checks honor the 24-hour cooldown without accessing the network", async (t) => {
  fs.mkdirSync(RUNTIME_TEMP_ROOT, { recursive: true });
  const statePath = path.join(RUNTIME_TEMP_ROOT, `update-check-${Date.now()}.json`);
  fs.writeFileSync(statePath, `${JSON.stringify({ checkedAt: 2000 })}\n`, "utf8");
  t.after(() => fs.rmSync(statePath, { force: true }));
  const result = await autoCheckForUpdates({ now: 3000, statePath });
  assert.equal(result.status, "skipped");
});

test("external termbase screen distinguishes mounting from deleting the source file", () => {
  const view = render(React.createElement(ExternalTermbasesScreen, {
    mounts: [{ id: "m1", name: "official.tbx", entryCount: 12, available: true }],
    notice: null,
    onMount() {},
    onUnmount() {},
    onBack() {},
  }));
  assert.match(view.lastFrame(), /挂载 TBX 文件或目录/);
  assert.match(view.lastFrame(), /移除挂载 · official\.tbx/);
  assert.match(view.lastFrame(), /不会删除原文件/);
  view.unmount();
});

test("project list keeps projects off the home screen and shows their progress", () => {
  const projects = [
    { projectDir: "one", title: "未完成项目", currentLabel: "等待 Stage 4" },
    { projectDir: "two", title: "已完成项目", currentLabel: "已完成" },
  ];
  const home = render(React.createElement(App, appProps));
  assert.doesNotMatch(home.lastFrame(), /未完成项目/);
  assert.doesNotMatch(home.lastFrame(), /已完成项目/);
  home.unmount();

  const list = render(React.createElement(ProjectList, { projects, onOpen: () => {}, onBack: () => {} }));
  assert.match(list.lastFrame(), /未完成项目  ·  等待 Stage 4/);
  assert.match(list.lastFrame(), /已完成项目  ·  已完成/);
  assert.match(list.lastFrame(), /返回首页/);
  list.unmount();
});

test("project list filters projects by typed search text", async () => {
  let opened;
  const projects = [
    { projectDir: "one", title: "汽车白皮书", currentLabel: "等待 Stage 4" },
    { projectDir: "two", title: "字幕翻译", currentLabel: "等待 Stage 2" },
  ];
  const list = render(React.createElement(ProjectList, {
    projects,
    onOpen: (project) => { opened = project; },
    onBack: () => {},
  }));
  list.stdin.write("字幕");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(list.lastFrame(), /搜索：字幕/);
  assert.match(list.lastFrame(), /字幕翻译/);
  assert.doesNotMatch(list.lastFrame(), /汽车白皮书/);
  list.stdin.write("\r");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(opened?.projectDir, "two");
  list.unmount();
});

test("first-run TUI opens on the home screen before model configuration", () => {
  const view = render(React.createElement(App, {
    initialScreen: "config",
    initialModel: { configured: false, label: "未配置" },
  }));
  assert.match(view.lastFrame(), /模型配置/);
  assert.match(view.lastFrame(), /选择模型服务商/);
  view.unmount();
});

test("default TUI entry stays on the home screen without model configuration", () => {
  const view = render(React.createElement(App, {
    initialModel: { configured: false, label: "未配置" },
  }));
  assert.match(view.lastFrame(), /多语言翻译 · A1batr055/);
  assert.doesNotMatch(view.lastFrame(), /选择模型服务商/);
  view.unmount();
});

test("domain taxonomy TUI exposes pending review and editable files", async () => {
  let selectedIndex = null;
  const view = render(React.createElement(DomainTaxonomyScreen, {
    domains: ["法律", "财经"],
    pending: [{ suggestion: "商务资料", title: "法律财经领域稿件", date: "2026-08-09" }],
    notice: null,
    onSelectPending: (index) => { selectedIndex = index; },
    onAdd: () => {},
    onOpen: () => {},
    onRefresh: () => {},
    onBack: () => {},
  }));
  assert.match(view.lastFrame(), /待处理 · 商务资料 · 法律财经领域稿件/);
  assert.match(view.lastFrame(), /打开个人领域词表（可直接编辑）/);
  assert.match(view.lastFrame(), /打开待归类记录（可直接编辑）/);
  assert.match(view.lastFrame(), /打开内置领域词表（随版本更新）/);
  view.stdin.write("\r");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(selectedIndex, 0);
  view.unmount();
});

test("pending-domain editor starts with the model suggestion and shows duplicate failure", () => {
  const view = render(React.createElement(DomainPendingEditScreen, {
    entry: { suggestion: "商务资料" },
    notice: { kind: "error", text: "领域“商务”已存在；待归类记录未改动。" },
    onSubmit: () => {},
    onBack: () => {},
  }));
  assert.match(view.lastFrame(), /收录名称/);
  assert.match(view.lastFrame(), /商务资料/);
  assert.match(view.lastFrame(), /商务.*已存在/);
  assert.match(view.lastFrame(), /待归类记录未改动/);
  view.unmount();
});

test("model catalog uses the provider endpoint and returns live model IDs", async () => {
  let request;
  const models = await listAvailableModels({
    protocol: "openai-compatible",
    baseURL: "https://api.deepseek.com/",
    apiKey: "secret",
  }, async (url, options) => {
    request = { url, options };
    return { ok: true, text: async () => JSON.stringify({ data: [{ id: "deepseek-v4-pro" }, { id: "deepseek-v4-flash" }] }) };
  });
  assert.equal(request.url, "https://api.deepseek.com/models");
  assert.equal(request.options.headers.Authorization, "Bearer secret");
  assert.deepEqual(models, ["deepseek-v4-flash", "deepseek-v4-pro"]);
});

test("Anthropic model catalog uses its native endpoint and authentication", async () => {
  let request;
  await listAvailableModels({
    protocol: "anthropic",
    baseURL: "https://api.anthropic.com",
    apiKey: "secret",
  }, async (url, options) => {
    request = { url, options };
    return { ok: true, text: async () => JSON.stringify({ data: [{ id: "claude-example" }] }) };
  });
  assert.equal(request.url, "https://api.anthropic.com/v1/models?limit=1000");
  assert.equal(request.options.headers["x-api-key"], "secret");
  assert.equal(request.options.headers["anthropic-version"], "2023-06-01");
});

test("model configuration loads models after the API key and keeps manual input", async () => {
  const view = render(React.createElement(ConfigWizard, {
    pendingLabel: "",
    onComplete: () => {},
    onBack: () => {},
    loadModels: async () => ["deepseek-v4-flash", "deepseek-v4-pro"],
  }));
  view.stdin.write("\r");
  await new Promise((resolve) => setTimeout(resolve, 10));
  view.stdin.write("\r");
  await new Promise((resolve) => setTimeout(resolve, 10));
  view.stdin.write("test-key");
  await new Promise((resolve) => setTimeout(resolve, 10));
  view.stdin.write("\r");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.match(view.lastFrame(), /deepseek-v4-flash/);
  assert.match(view.lastFrame(), /deepseek-v4-pro/);
  assert.match(view.lastFrame(), /手动输入模型 ID/);
  assert.match(view.lastFrame(), /刷新可用模型/);
  view.unmount();
});

test("configured provider can switch models without entering credentials again", async () => {
  let selected;
  const config = {
    provider: "deepseek",
    deepseek: {
      protocol: "openai-compatible",
      baseURL: "https://api.deepseek.com",
      model: "deepseek-v4-pro",
      apiKey: "saved-key",
    },
  };
  const view = render(React.createElement(ModelSwitch, {
    config,
    onComplete: (model) => { selected = model; },
    onReconfigure: () => {},
    onBack: () => {},
    loadModels: async (provider) => {
      assert.equal(provider.apiKey, "saved-key");
      return ["deepseek-v4-flash", "deepseek-v4-pro"];
    },
  }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.match(view.lastFrame(), /切换模型/);
  assert.match(view.lastFrame(), /deepseek-v4-pro  ·  当前/);
  assert.match(view.lastFrame(), /重新配置服务商 \/ API Key/);
  view.stdin.write("\r");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(selected, "deepseek-v4-flash");
  view.unmount();
});

test("create-project wizard separates source and target language selection", async () => {
  const view = render(React.createElement(App, appProps));
  view.stdin.write("\r");
  await new Promise((resolve) => setTimeout(resolve, 10));
  view.stdin.write("source.txt");
  view.stdin.write("\r");
  await new Promise((resolve) => setTimeout(resolve, 10));
  view.stdin.write("\r");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(view.lastFrame(), /选择源语/);
  assert.doesNotMatch(view.lastFrame(), /自动识别/);
  assert.doesNotMatch(view.lastFrame(), /选择目标语/);
  assert.doesNotMatch(view.lastFrame(), /句段 ID 前缀/);
  view.unmount();
});

test("language direction detects English source and maps term fields", () => {
  const direction = detectDirection([{ text: "Translation memory stores approved bilingual segments." }]);
  assert.equal(direction, "en-zh");
  const profile = resolveLanguageProfile(direction);
  assert.equal(profile.targetLanguage, "zh-CN");
  assert.deepEqual(termFields(profile), { sourceField: "en_US", targetField: "zh_CN" });
});

test("custom language direction creates dynamic term fields", () => {
  const profile = resolveLanguageProfile("ja-JP->en-US");
  assert.equal(profile.sourceLanguage, "ja-JP");
  assert.equal(profile.targetLanguage, "en-US");
  assert.deepEqual(termFields(profile), { sourceField: "ja_JP", targetField: "en_US" });
  assert.deepEqual(reviewHeaders(profile), ["id", "日文", "英文译法", "领域", "依据", "来源 URL", "删除", "疑似重复"]);
});

test("automatic source detection is disabled", () => {
  assert.throws(() => resolveLanguageProfile("auto->zh-CN", [{ text: "This is an English source." }]), /已停用自动识别/);
});

test("custom language direction checks target realization", () => {
  const config = resolveLanguageProfile("ja-en");
  const report = checkRealization(
    [{ id: "CAND-0001", ja: "テスト", en: "test", status: "首选", source_segment_id: "SEG-0001" }],
    [{ id: "SEG-0001", source: "これはテストです。", target: "This is a sample." }],
    config,
  );
  assert.equal(report.length, 1);
  assert.equal(report[0].expected, "test");
});

test("English source extracts English terms with Chinese candidates", async () => {
  const config = {
    ...resolveLanguageProfile("en-zh"),
    domain: "翻译技术",
    defaultTopic: "翻译记忆",
    sections: [],
  };
  const segments = [{ id: "SEG-0001", text: "Translation memory stores approved segments." }];
  const candidates = await extractCandidates(segments, config, async (request) => {
    assert.match(request.user, /英文原文/);
    assert.match(request.user, /zh_CN\(唯一中文译法/);
    return {
      terms: [{
        en_US: "translation memory",
        zh_CN: "翻译记忆",
        source_segment_id: "SEG-0001",
      }],
    };
  });
  assert.equal(candidates[0].en_US, "translation memory");
  assert.equal(candidates[0].zh_CN, "翻译记忆");
});

test("English source translates to Chinese and applies the reversed glossary", async () => {
  const config = {
    ...resolveLanguageProfile("en-zh"),
    domain: "翻译技术",
    defaultTopic: "翻译记忆",
    defaultStyleNote: "技术说明",
    sections: [],
  };
  const segments = [{ id: "SEG-0001", text: "Translation memory stores approved segments.", target: "" }];
  const glossary = [{ en_US: "Translation memory", zh_CN: "翻译记忆", status: "首选" }];
  const translated = await translateWithGlossary(segments, glossary, config, async (request) => {
    assert.match(request.user, /Translation memory → 翻译记忆/);
    assert.match(request.user, /英文原文逐条译成中文/);
    return { translations: [{ id: "SEG-0001", target: "翻译记忆保存已确认的句段。" }] };
  });
  assert.equal(translated[0].target, "翻译记忆保存已确认的句段。");
});

test("English source review workbook labels English as source and Chinese as target", () => {
  assert.deepEqual(
    reviewHeaders(resolveLanguageProfile("en-zh")),
    ["id", "英文", "中文译法", "领域", "依据", "来源 URL", "删除", "疑似重复"],
  );
});

test("project screen keeps all eight stages visible", () => {
  const stages = ["文本分析", "术语抽取", "术语查证", "人工确认", "翻译", "译后编辑", "术语核查", "交付"]
    .map((name, index) => ({ number: index + 1, name, complete: index < 3, current: index === 3 }));
  const project = {
    title: "测试项目",
    currentLabel: "等待 Stage 4",
    stages,
    archived: false,
    config: { sourceColumnLabel: "英文原文", targetColumnLabel: "中文译文" },
    evidenceSummary: { doNotTranslate: 1, local: 2, webSearch: 3, modelKnowledge: 1, webNotFound: 0, webError: 1 },
  };
  const view = render(React.createElement(ProjectView, {
    project,
    notice: null,
    onAction: () => {},
    onBack: () => {},
  }));
  for (let number = 1; number <= 8; number += 1) {
    assert.match(view.lastFrame(), new RegExp(`Stage ${number}`));
  }
  assert.match(view.lastFrame(), /删除项目/);
  assert.match(view.lastFrame(), /术语分流：不译 → 本地 → 联网查证 → 模型知识/);
  assert.match(view.lastFrame(), /不译 1｜本地 2｜联网查证 3（交叉查证 0｜单一来源 3）｜模型知识 1/);
  assert.match(view.lastFrame(), /模型知识入口：联网未检出 0｜联网失败 1/);
  view.unmount();
});

test("target language picker clears the source language search", async () => {
  const view = render(React.createElement(App, appProps));
  view.stdin.write("\r");
  await new Promise((resolve) => setTimeout(resolve, 10));
  view.stdin.write("source.txt");
  view.stdin.write("\r");
  await new Promise((resolve) => setTimeout(resolve, 10));
  view.stdin.write("\r");
  await new Promise((resolve) => setTimeout(resolve, 10));
  view.stdin.write("英语");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(view.lastFrame(), /英语（en-US）/);
  assert.doesNotMatch(view.lastFrame(), /中文（zh-CN）/);
  view.stdin.write("\r");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(view.lastFrame(), /选择目标语/);
  assert.match(view.lastFrame(), /中文（zh-CN）/);
  assert.match(view.lastFrame(), /输入中文、英文名或语言代码/);
  view.unmount();
});

test("project screen exposes the optional project override workbook before preparation", () => {
  const stages = ["文本分析", "术语抽取", "术语查证", "人工确认", "翻译", "译后编辑", "术语核查", "交付"]
    .map((name, index) => ({ number: index + 1, name, complete: false, current: index === 0 }));
  const view = render(React.createElement(ProjectView, {
    project: {
      title: "待准备项目",
      currentLabel: "等待 Stage 1",
      stages,
      archived: false,
      config: { sourceColumnLabel: "英文原文", targetColumnLabel: "中文译文" },
    },
    notice: null,
    onAction: () => {},
    onBack: () => {},
  }));
  assert.match(view.lastFrame(), /填写项目专用译法（可选）/);
  assert.match(view.lastFrame(), /运行 Stages 1–3/);
  view.unmount();
});

test("project inspection reloads the persisted verification summary", (t) => {
  fs.mkdirSync(RUNTIME_TEMP_ROOT, { recursive: true });
  const projectDir = fs.mkdtempSync(path.join(RUNTIME_TEMP_ROOT, "tui-summary-"));
  const projectName = path.basename(projectDir);
  const configDir = path.join(projectDir, "99_项目配置与术语源数据");
  const workDir = path.join(process.cwd(), "work", projectName);
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "asset-config.json"), JSON.stringify({
    title: "查证摘要测试",
    domain: "翻译技术",
    sourceColumnLabel: "原文",
    targetColumnLabel: "译文",
    workbookName: "候选术语审阅.xlsx",
  }), "utf8");
  fs.writeFileSync(path.join(workDir, "evidence.jsonl"), [
    JSON.stringify({ candidate_id: "c1", source: "local", quote: "local", url: "" }),
    JSON.stringify({ candidate_id: "c2", source: "model_knowledge", quote: "[联网未检出][中]模型知识", url: "" }),
  ].join("\n") + "\n", "utf8");
  t.after(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  const project = inspectProject(projectDir);
  assert.deepEqual(project.evidenceSummary, {
    doNotTranslate: 0,
    local: 1,
    webSearch: 0,
    webCrossChecked: 0,
    webSingleSource: 0,
    modelKnowledge: 1,
    webNotFound: 1,
    webError: 0,
  });
});
