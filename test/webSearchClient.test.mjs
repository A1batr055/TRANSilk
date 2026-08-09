import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  anthropicTrace,
  chatTrace,
  responseTrace,
  searchWebEvidence,
  validateGroundedResult,
} from "../src/lib/webSearchClient.mjs";
import { RUNTIME_TEMP_ROOT } from "../src/lib/paths.mjs";
import { formatEvidenceSummary, summarizeEvidence } from "../src/lib/evidenceSummary.mjs";
import { exportCandidatesToWorkbook, importReviewedGlossary } from "../src/stages/04-freeze.mjs";
import { readSimpleWorkbook } from "../src/lib/xlsx.mjs";
import { verifyCandidates } from "../src/stages/03-verify.mjs";

const config = {
  sourceLanguage: "zh-CN",
  targetLanguage: "en-US",
  sourceTermField: "zh_CN",
  targetTermField: "en_US",
  domain: "翻译技术",
};
const candidates = [{ id: "c1", zh_CN: "联网防幻觉测试词", en_US: "web grounding test term", domain: "翻译技术" }];

function mockResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

function pageResponse(text) {
  return { ok: true, status: 200, headers: { get: () => String(text.length) }, text: async () => text };
}

function foundClaim(evidence) {
  return { id: "c1", status: "found", evidence, reason: "" };
}

test("grounded evidence keeps multiple verified sources and marks cross-checking", () => {
  const result = validateGroundedResult("c1", foundClaim([
    { quote: "Official terminology entry.", url: "https://official.example/term" },
    { quote: "Independent terminology record.", url: "https://reference.example/term" },
  ]), {
    requested: true,
    completed: true,
    failed: false,
    sources: [
      { url: "https://official.example/term", title: "Official", excerpt: "Official terminology entry." },
      { url: "https://reference.example/term", title: "Reference", excerpt: "Independent terminology record." },
      { url: "https://irrelevant.example/page", title: "Other", excerpt: "Other result." },
    ],
  });
  assert.equal(result.status, "found");
  assert.equal(result.verification_level, "cross_checked");
  assert.equal(result.sources.length, 2);
  assert.equal(result.searched_sources.length, 3);
});

test("multiple pages from the same host remain single-source evidence", () => {
  const result = validateGroundedResult("c1", foundClaim([
    { quote: "Definition", url: "https://official.example/terms/one" },
    { quote: "Usage", url: "https://www.official.example/terms/two" },
  ]), {
    requested: true,
    completed: true,
    failed: false,
    sources: [
      { url: "https://official.example/terms/one", excerpt: "Definition" },
      { url: "https://www.official.example/terms/two", excerpt: "Usage" },
    ],
  });
  assert.equal(result.status, "found");
  assert.equal(result.verification_level, "single_source");
  assert.equal(result.sources.length, 2);
});

test("a tool request without a completed result is rejected", () => {
  const result = validateGroundedResult("c1", foundClaim([
    { quote: "Claim", url: "https://example.org/term" },
  ]), { requested: true, completed: false, failed: false, sources: [] });
  assert.equal(result.status, "error");
  assert.match(result.error, /没有完成的搜索结果/);
});

test("a model-authored URL outside tool sources is rejected", () => {
  const result = validateGroundedResult("c1", foundClaim([
    { quote: "Invented", url: "https://invented.example/term" },
  ]), {
    requested: true,
    completed: true,
    failed: false,
    sources: [{ url: "https://real.example/term", title: "Real", excerpt: "Real source" }],
  });
  assert.equal(result.status, "error");
  assert.match(result.error, /不在真实搜索结果/);
});

test("a model-authored quote that contradicts the tool excerpt is rejected", () => {
  const result = validateGroundedResult("c1", foundClaim([
    { quote: "Invented definition", url: "https://real.example/term" },
  ]), {
    requested: true,
    completed: true,
    failed: false,
    sources: [{ url: "https://real.example/term", title: "Real", excerpt: "Verified definition" }],
  });
  assert.equal(result.status, "error");
  assert.match(result.error, /依据摘录与真实搜索结果不符/);
});

test("not_found requires a completed search and preserves its reason", () => {
  const result = validateGroundedResult("c1", {
    id: "c1", status: "not_found", evidence: [], reason: "来源互相冲突",
  }, { requested: true, completed: true, failed: false, sources: [] });
  assert.deepEqual(result, { candidate_id: "c1", status: "not_found", reason: "来源互相冲突" });
});

test("Responses trace requires a real web_search_call and extracts citations", () => {
  const trace = responseTrace({ output: [
    { type: "web_search_call", status: "completed", action: { type: "search", sources: [{ url: "https://example.org/term" }] } },
    { type: "message", content: [{ type: "output_text", annotations: [{ type: "url_citation", url: "https://reference.example/term" }] }] },
  ] });
  assert.equal(trace.completed, true);
  assert.deepEqual(trace.sources.map((item) => item.url).sort(), ["https://example.org/term", "https://reference.example/term"]);
});

test("Responses trace does not count a request action without result sources or citations", () => {
  const trace = responseTrace({ output: [{ type: "web_search_call", status: "in_progress", action: { type: "search" } }] });
  assert.equal(trace.requested, true);
  assert.equal(trace.completed, false);
});

test("Anthropic trace correlates server tool use with its result", () => {
  const trace = anthropicTrace({ content: [
    { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "term" } },
    { type: "web_search_tool_result", tool_use_id: "s1", content: [{ type: "web_search_result", url: "https://example.org/term" }] },
  ] });
  assert.equal(trace.completed, true);
  assert.equal(trace.sources[0].url, "https://example.org/term");
});

test("Chat trace does not trust assistant text without a provider search signal", () => {
  const trace = chatTrace({ choices: [{ message: { content: "I searched https://invented.example" } }] }, "qwen");
  assert.equal(trace.requested, false);
  assert.equal(trace.sources.length, 0);
});

test("Chat trace does not treat a client function call as completed server search", () => {
  const trace = chatTrace({ choices: [{ message: { tool_calls: [{ type: "function", function: { name: "web_search" } }] } }] }, "custom");
  assert.equal(trace.requested, false);
  assert.equal(trace.completed, false);
});

test("generic OpenAI-compatible Responses search is not restricted by provider name", async () => {
  const requests = [];
  const [result] = await searchWebEvidence(candidates, config, {
    secrets: { provider: "custom", custom: { protocol: "openai-compatible", baseURL: "https://compatible.example/v1", model: "search-model", apiKey: "secret" } },
    fetchImpl: async (url, request) => {
      requests.push({ url, body: JSON.parse(request.body) });
      return mockResponse({ output: [
        { type: "web_search_call", status: "completed", action: { type: "search", sources: [{ url: "https://example.org/term" }] } },
        { type: "message", content: [{
          type: "output_text",
          text: JSON.stringify({ results: [foundClaim([{ quote: "A terminology database.", url: "https://example.org/term" }])] }),
          annotations: [{ type: "url_citation", url: "https://example.org/term" }],
        }] },
      ] });
    },
  });
  assert.equal(requests[0].url, "https://compatible.example/v1/responses");
  assert.deepEqual(requests[0].body.tool_choice, { type: "web_search" });
  assert.equal(result.status, "found");
});

test("DeepSeek Responses uses the configured API without a provider-specific rejection", async () => {
  let requestedUrl = "";
  const [result] = await searchWebEvidence(candidates, config, {
    secrets: { provider: "deepseek", deepseek: { protocol: "openai-compatible", baseURL: "https://api.deepseek.com", model: "deepseek-v4-flash", apiKey: "secret" } },
    fetchImpl: async (url) => {
      requestedUrl = url;
      return mockResponse({ output: [
        { type: "web_search_call", status: "completed", action: { sources: [] } },
        { type: "message", content: [{ type: "output_text", text: JSON.stringify({ results: [{ id: "c1", status: "not_found", evidence: [], reason: "未检出" }] }) }] },
      ] });
    },
  });
  assert.equal(requestedUrl, "https://api.deepseek.com/responses");
  assert.equal(result.status, "not_found");
});

test("DeepSeek V4 Pro uses the official Anthropic-compatible search surface", async () => {
  let requestedUrl = "";
  const [result] = await searchWebEvidence(candidates, config, {
    secrets: { provider: "deepseek", deepseek: { protocol: "openai-compatible", baseURL: "https://api.deepseek.com", model: "deepseek-v4-pro", apiKey: "secret" } },
    fetchImpl: async (url) => {
      requestedUrl = url;
      return mockResponse({ content: [
        { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "term" } },
        { type: "web_search_tool_result", tool_use_id: "s1", content: [] },
        { type: "text", text: JSON.stringify({ results: [{ id: "c1", status: "not_found", evidence: [], reason: "未检出" }] }) },
      ] });
    },
  });
  assert.equal(requestedUrl, "https://api.deepseek.com/anthropic/v1/messages");
  assert.equal(result.status, "not_found");
});

test("Anthropic native web search accepts only tool-backed evidence", async () => {
  const [result] = await searchWebEvidence(candidates, config, {
    secrets: { provider: "anthropic", anthropic: { protocol: "anthropic", baseURL: "https://api.anthropic.com", model: "example", apiKey: "secret" } },
    fetchImpl: async () => mockResponse({ content: [
      { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "term" } },
      { type: "web_search_tool_result", tool_use_id: "s1", content: [{ type: "web_search_result", url: "https://example.org/term" }] },
      { type: "text", text: JSON.stringify({ results: [foundClaim([{ quote: "A terminology database.", url: "https://example.org/term" }])] }), citations: [{ type: "web_search_result_location", url: "https://example.org/term" }] },
    ] }),
  });
  assert.equal(result.status, "found");
});

for (const fixture of [
  { name: "Zhipu Chat", provider: { baseURL: "https://open.bigmodel.cn/api/paas/v4", model: "glm-5.2" }, signal: { search_result: [{ link: "https://example.org/term", content: "A terminology database." }] }, expected: "zhipu" },
  { name: "Qwen Chat", provider: { baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" }, signal: { search_info: { search_results: [{ url: "https://example.org/term", snippet: "A terminology database." }] } }, expected: "qwen" },
  { name: "OpenRouter", provider: { baseURL: "https://openrouter.ai/api/v1", model: "openai/gpt-5" }, signal: { usage: { server_tool_use: { web_search_requests: 1 } }, choices: [{ message: { annotations: [{ type: "url_citation", url_citation: { url: "https://example.org/term", content: "A terminology database." } }] } }] }, expected: "openrouter" },
]) {
  test(`${fixture.name} uses its Chat search extension and validates returned sources`, async () => {
    let requestBody;
    const [result] = await searchWebEvidence(candidates, config, {
      secrets: { provider: "custom", custom: { protocol: "openai-compatible", apiKey: "secret", ...fixture.provider } },
      fetchImpl: async (_url, request) => {
        requestBody = JSON.parse(request.body);
        const content = JSON.stringify({ results: [foundClaim([{ quote: "A terminology database.", url: "https://example.org/term" }])] });
        const body = { ...fixture.signal, choices: [{ message: { content } }] };
        if (fixture.expected === "openrouter") body.choices[0].message.annotations = fixture.signal.choices[0].message.annotations;
        return mockResponse(body);
      },
    });
    assert.equal(result.status, "found");
    if (fixture.expected === "zhipu") assert.equal(requestBody.tools[0].type, "web_search");
    if (fixture.expected === "qwen") assert.equal(requestBody.search_options.forced_search, true);
    if (fixture.expected === "openrouter") assert.equal(requestBody.tools[0].type, "openrouter:web_search");
  });
}

test("Codex CLI requires a completed web event", async () => {
  const runImpl = async () => [
    JSON.stringify({ type: "item.completed", item: { id: "w1", type: "web_search", status: "completed", action: { type: "open_page", url: "https://example.org/term" } } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ results: [foundClaim([{ quote: "A terminology database.", url: "https://example.org/term" }])] }) } }),
  ].join("\n");
  const [result] = await searchWebEvidence(candidates, config, {
    secrets: { provider: "codex-cli", "codex-cli": { protocol: "cli-agent", cli: "codex" } },
    runImpl,
    lookupImpl: async () => [{ address: "203.0.113.10", family: 4 }],
    fetchImpl: async () => pageResponse("A terminology database."),
  });
  assert.equal(result.status, "found");
});

test("Codex CLI verifies a selected URL by reading the public page when events omit sources", async () => {
  const runImpl = async () => [
    JSON.stringify({ type: "item.started", item: { id: "w1", type: "web_search", action: { type: "search" } } }),
    JSON.stringify({ type: "item.completed", item: { id: "w1", type: "web_search", status: "completed", action: { type: "search", query: "term" } } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ results: [foundClaim([{ quote: "Verified terminology definition", url: "https://docs.example/term" }])] }) } }),
  ].join("\n");
  const [result] = await searchWebEvidence(candidates, config, {
    secrets: { provider: "codex-cli", "codex-cli": { protocol: "cli-agent", cli: "codex" } },
    runImpl,
    lookupImpl: async () => [{ address: "203.0.113.10", family: 4 }],
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "128" },
      text: async () => "<html><body>Verified terminology definition</body></html>",
    }),
  });
  assert.equal(result.status, "found");
  assert.equal(result.sources[0].url, "https://docs.example/term");
  assert.equal(result.sources[0].excerpt, "Verified terminology definition");
});

test("Codex CLI verifies multiple terms in one CLI invocation", async () => {
  const batchCandidates = [
    candidates[0],
    { id: "c2", zh_CN: "访问令牌", en_US: "access token", domain: "信息技术" },
  ];
  let calls = 0;
  const runImpl = async (_command, _args, input) => {
    calls += 1;
    assert.match(input, /联网防幻觉测试词/);
    assert.match(input, /访问令牌/);
    return [
      JSON.stringify({ type: "item.completed", item: { id: "w1", type: "web_search", status: "completed", action: { type: "search", query: "terms" } } }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ results: [
        foundClaim([{ quote: "First definition", url: "https://docs.example/first" }]),
        { id: "c2", status: "found", evidence: [{ quote: "Second definition", url: "https://docs.example/second" }], reason: "" },
      ] }) } }),
    ].join("\n");
  };
  const results = await searchWebEvidence(batchCandidates, config, {
    secrets: { provider: "codex-cli", "codex-cli": { protocol: "cli-agent", cli: "codex" } },
    runImpl,
    lookupImpl: async () => [{ address: "203.0.113.10", family: 4 }],
    fetchImpl: async (url) => pageResponse(url.endsWith("/first") ? "First definition" : "Second definition"),
  });
  assert.equal(calls, 1);
  assert.deepEqual(results.map((item) => item.status), ["found", "found"]);
  assert.deepEqual(results.map((item) => item.sources[0].excerpt), ["First definition", "Second definition"]);
});

test("Codex CLI rejects a batch not-found claim without a matching completed query", async () => {
  const batchCandidates = [
    candidates[0],
    { id: "c2", zh_CN: "访问令牌", en_US: "access token", domain: "信息技术" },
  ];
  const runImpl = async () => [
    JSON.stringify({ type: "item.completed", item: { id: "w1", type: "web_search", status: "completed", action: { type: "search", query: "联网防幻觉测试词" } } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ results: [
      { id: "c1", status: "not_found", evidence: [], reason: "未检出" },
      { id: "c2", status: "not_found", evidence: [], reason: "未检出" },
    ] }) } }),
  ].join("\n");
  const results = await searchWebEvidence(batchCandidates, config, {
    secrets: { provider: "codex-cli", "codex-cli": { protocol: "cli-agent", cli: "codex" } },
    runImpl,
  });
  assert.equal(results[0].status, "not_found");
  assert.equal(results[1].status, "error");
  assert.match(results[1].error, /没有检测到该术语对应的已完成搜索查询/);
});

test("Codex CLI refuses to fetch a model-selected private URL", async () => {
  const runImpl = async () => [
    JSON.stringify({ type: "item.completed", item: { id: "w1", type: "web_search", status: "completed", action: { type: "search", query: "term" } } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ results: [foundClaim([{ quote: "Private", url: "http://127.0.0.1/term" }])] }) } }),
  ].join("\n");
  let fetched = false;
  const [result] = await searchWebEvidence(candidates, config, {
    secrets: { provider: "codex-cli", "codex-cli": { protocol: "cli-agent", cli: "codex" } },
    runImpl,
    fetchImpl: async () => { fetched = true; throw new Error("should not fetch"); },
  });
  assert.equal(result.status, "error");
  assert.match(result.error, /本机或内网/);
  assert.equal(fetched, false);
});

test("Claude CLI correlates tool_result with tool_use", async () => {
  const runImpl = async () => [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "WebSearch", input: { query: "term" } }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "https://example.org/term" }] } }),
    JSON.stringify({ type: "result", result: JSON.stringify({ results: [foundClaim([{ quote: "A terminology database.", url: "https://example.org/term" }])] }) }),
  ].join("\n");
  const [result] = await searchWebEvidence(candidates, config, {
    secrets: { provider: "claude-cli", "claude-cli": { protocol: "cli-agent", cli: "claude" } },
    runImpl,
    lookupImpl: async () => [{ address: "203.0.113.10", family: 4 }],
    fetchImpl: async () => pageResponse("A terminology database."),
  });
  assert.equal(result.status, "found");
});

test("Stage 3 records a web failure before using model knowledge", async (t) => {
  fs.mkdirSync(RUNTIME_TEMP_ROOT, { recursive: true });
  const projectDir = fs.mkdtempSync(path.join(RUNTIME_TEMP_ROOT, "stage3-web-"));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  const evidence = await verifyCandidates(candidates, config, projectDir, {
    webSearch: async () => [{ candidate_id: "c1", status: "error", error: "连接超时" }],
    modelKnowledge: async () => [{ candidate_id: "c1", source: "model_knowledge", quote: "[中]模型知识", url: "" }],
  });
  assert.equal(evidence[0].source, "model_knowledge");
  assert.match(evidence[0].quote, /^\[联网失败：连接超时\]/);
  assert.equal(evidence[0].web_fallback_status, "error");
  assert.equal(evidence[0].web_fallback_reason, "连接超时");
});

test("Stage 3 preserves a not-found reason before model knowledge", async (t) => {
  fs.mkdirSync(RUNTIME_TEMP_ROOT, { recursive: true });
  const projectDir = fs.mkdtempSync(path.join(RUNTIME_TEMP_ROOT, "stage3-web-"));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  const evidence = await verifyCandidates(candidates, config, projectDir, {
    webSearch: async () => [{ candidate_id: "c1", status: "not_found", reason: "来源互相冲突" }],
    modelKnowledge: async () => [{ candidate_id: "c1", source: "model_knowledge", quote: "[中]模型知识", url: "" }],
  });
  assert.match(evidence[0].quote, /^\[联网未检出：来源互相冲突\]/);
  assert.equal(evidence[0].web_fallback_status, "not_found");
  assert.equal(evidence[0].web_fallback_reason, "来源互相冲突");
});

test("Stage 3 keeps verified multi-source evidence and skips model knowledge", async (t) => {
  fs.mkdirSync(RUNTIME_TEMP_ROOT, { recursive: true });
  const projectDir = fs.mkdtempSync(path.join(RUNTIME_TEMP_ROOT, "stage3-web-"));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  let knowledgeCalled = false;
  const sources = [{ url: "https://a.example/term", quote: "A" }, { url: "https://b.example/term", quote: "B" }];
  const evidence = await verifyCandidates(candidates, config, projectDir, {
    webSearch: async () => [{ candidate_id: "c1", status: "found", quote: "A｜B", url: sources[0].url, sources, verification_level: "cross_checked" }],
    modelKnowledge: async () => { knowledgeCalled = true; return []; },
  });
  assert.equal(knowledgeCalled, false);
  assert.equal(evidence[0].source, "web_search");
  assert.equal(evidence[0].sources.length, 2);
});

test("Stage 3 reports each gate in order", async (t) => {
  fs.mkdirSync(RUNTIME_TEMP_ROOT, { recursive: true });
  const projectDir = fs.mkdtempSync(path.join(RUNTIME_TEMP_ROOT, "stage3-progress-"));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  const progress = [];
  await verifyCandidates(candidates, config, projectDir, {
    webSearch: async () => [{ candidate_id: "c1", status: "not_found", reason: "证据不足" }],
    modelKnowledge: async () => [{ candidate_id: "c1", source: "model_knowledge", quote: "[低]不确定", url: "" }],
    onProgress: (item) => progress.push(item),
  });
  assert.deepEqual(progress.map((item) => item.step), ["do_not_translate", "local", "web_started", "web", "model_knowledge"]);
  assert.equal(progress[3].notFound, 1);
});

test("Stage 3 skips all verification gates for do-not-translate candidates", async (t) => {
  fs.mkdirSync(RUNTIME_TEMP_ROOT, { recursive: true });
  const projectDir = fs.mkdtempSync(path.join(RUNTIME_TEMP_ROOT, "stage3-dnt-"));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  let webCalled = false;
  let knowledgeCalled = false;
  const evidence = await verifyCandidates([{
    ...candidates[0],
    zh_CN: "OAuth 2.0",
    en_US: "OAuth 2.0",
    translation_action: "do_not_translate",
    translation_action_reason: "标准名称原样保留",
  }], config, projectDir, {
    webSearch: async (items) => { webCalled = items.length > 0; return []; },
    modelKnowledge: async () => { knowledgeCalled = true; return []; },
  });
  assert.equal(webCalled, false);
  assert.equal(knowledgeCalled, false);
  assert.deepEqual(evidence, [{ candidate_id: "c1", source: "do_not_translate", quote: "标准名称原样保留", url: "" }]);
});

test("evidence summary preserves the three verification gates", () => {
  const summary = summarizeEvidence([
    { source: "local", quote: "local" },
    { source: "web_search", quote: "web", url: "https://example.org", verification_level: "cross_checked" },
    { source: "model_knowledge", quote: "[联网未检出：来源冲突][中]模型知识" },
    { source: "model_knowledge", quote: "[联网失败：超时][低]模型知识" },
  ]);
  assert.deepEqual(summary, { doNotTranslate: 0, local: 1, webSearch: 1, webCrossChecked: 1, webSingleSource: 0, modelKnowledge: 2, webNotFound: 1, webError: 1 });
  assert.equal(formatEvidenceSummary(summary), "不译 0｜本地 1｜联网查证 1（交叉查证 1｜单一来源 0）｜模型知识 2");
});

test("review workbook exposes all selected source URLs", async (t) => {
  fs.mkdirSync(RUNTIME_TEMP_ROOT, { recursive: true });
  const workbookPath = path.join(RUNTIME_TEMP_ROOT, `web-source-${Date.now()}.xlsx`);
  t.after(() => fs.rmSync(workbookPath, { force: true }));
  const evidence = [{
    candidate_id: "c1",
    source: "web_search",
    quote: "source text",
    url: "https://example.org/term",
    sources: [
      { url: "https://example.org/term", title: "Example", excerpt: "source text" },
      { url: "https://reference.example/term", title: "Reference", excerpt: "reference text" },
    ],
    verification_level: "cross_checked",
  }];
  await exportCandidatesToWorkbook(candidates, evidence, workbookPath, config);
  const workbook = await readSimpleWorkbook(fs.readFileSync(workbookPath));
  const urlColumn = workbook.headers.indexOf("来源 URL");
  assert.ok(urlColumn >= 0);
  assert.equal(workbook.rows[0][urlColumn], "https://example.org/term\nhttps://reference.example/term");
  const [frozen] = await importReviewedGlossary(workbookPath, candidates, evidence);
  assert.equal(frozen.evidence_verification_level, "cross_checked");
  assert.deepEqual(frozen.evidence_sources, evidence[0].sources);
});
