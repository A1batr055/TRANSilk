import fs from "node:fs";
import path from "node:path";
import { callModel } from "../lib/modelClient.mjs";
import { termFields } from "../lib/language.mjs";
import { buildTermbaseIndex, lookupTerm } from "../lib/localTermbase.mjs";
import { searchWebEvidence } from "../lib/webSearchClient.mjs";

// 联网证据必须通过真实搜索工具事件校验；模型知识必须明确标记为无出处。
function loadOverrides(projectDir) {
  const p = path.join(projectDir, "99_项目配置与术语源数据", "overrides.json");
  if (!fs.existsSync(p)) return {};
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function overrideFor(overrides, sourceTerm, domain) {
  const scoped = overrides[`${sourceTerm}::${domain}`];
  return scoped !== undefined ? scoped : overrides[sourceTerm];
}

export function checkOverridesAndLocal(candidates, config, projectDir) {
  const { sourceField, targetField } = termFields(config);
  const overrides = loadOverrides(projectDir);
  const termbaseIndex = buildTermbaseIndex();
  const evidence = [];
  const needsWebSearch = [];

  for (const c of candidates) {
    if (c.translation_action === "do_not_translate") {
      evidence.push({
        candidate_id: c.id,
        source: "do_not_translate",
        quote: c.translation_action_reason || "原文固定写法",
        url: "",
      });
      continue;
    }
    const override = overrideFor(overrides, c[sourceField], c.domain || config.domain);
    if (override) {
      evidence.push({
        candidate_id: c.id,
        source: "local",
        quote: typeof override === "string" ? override : override[targetField],
        url: "",
      });
      continue;
    }
    const localMatches = lookupTerm(termbaseIndex, config.sourceLanguage, c[sourceField], c.domain || config.domain);
    if (localMatches.length === 1) {
      evidence.push({ candidate_id: c.id, source: "local", quote: localMatches[0].targetTerm, url: "" });
      continue;
    }
    needsWebSearch.push(c);
  }

  return { evidence, needsWebSearch };
}

export function applyWebSearchResults(evidence, webResults) {
  return [...evidence, ...webResults.map((r) => ({ ...r, source: "web_search" }))];
}

export async function applyModelKnowledge(candidate, config) {
  const { sourceField, targetField } = termFields(config);
  const sourceLabel = config.sourceLabel || config.sourceLanguage;
  const targetLabel = config.targetLabel || config.targetLanguage;
  const result = await callModel({
    system:
      `你是术语查证助手。基于你的知识判断给定${sourceLabel}术语在指定领域下最恰当的${targetLabel}译法，` +
      "如果不确定就如实说不确定，不要编造出处。只输出JSON。",
    user:
      `领域：${candidate.domain || config.domain}\n${sourceLabel}术语：${candidate[sourceField]}\n当前候选${targetLabel}译法：${candidate[targetField]}\n` +
      `请回复：{"confirmed_target":"...","confidence":"高|中|低","rationale":"一两句话说明依据或不确定的原因"}`,
    json: true,
  });
  return {
    candidate_id: candidate.id,
    source: "model_knowledge",
    quote: `[${result.confidence}]${result.rationale}`,
    url: "",
  };
}

export async function applyModelKnowledgeBatch(candidates, config, batchSize = 25) {
  const { sourceField, targetField } = termFields(config);
  const sourceLabel = config.sourceLabel || config.sourceLanguage;
  const targetLabel = config.targetLabel || config.targetLanguage;
  const results = [];
  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);
    const listed = batch
      .map((c) => `${c.id}｜领域:${c.domain || config.domain}｜${c[sourceField]}｜候选译法:${c[targetField]}`)
      .join("\n");
    const result = await callModel({
      system:
        `你是术语查证助手。基于你的知识逐条判断给定${sourceLabel}术语在指定领域下最恰当的${targetLabel}译法，` +
        "如果不确定就如实说不确定，不要编造出处。只输出JSON。",
      user:
        `以下每行是一条候选术语(id｜领域｜${sourceLabel}｜当前候选${targetLabel}译法)，各条领域可能不同，` +
        `请逐条按各自领域判断：\n${listed}\n\n` +
        `按此JSON格式逐条回复，id必须跟输入一一对应：\n` +
        `{"results": [{"id":"...","confirmed_target":"...","confidence":"高|中|低","rationale":"一两句话"}]}`,
      json: true,
    });
    for (const r of result.results ?? []) {
      results.push({
        candidate_id: r.id,
        source: "model_knowledge",
        quote: `[${r.confidence}]${r.rationale}`,
        url: "",
      });
    }
  }
  return results;
}

export async function verifyCandidates(candidates, config, projectDir, {
  webSearch = searchWebEvidence,
  modelKnowledge = applyModelKnowledgeBatch,
  onProgress = () => {},
} = {}) {
  const { evidence: base, needsWebSearch } = checkOverridesAndLocal(candidates, config, projectDir);
  const doNotTranslate = base.filter((item) => item.source === "do_not_translate").length;
  const local = base.filter((item) => item.source === "local").length;
  onProgress({ step: "do_not_translate", total: candidates.length, found: doNotTranslate });
  onProgress({
    step: "local",
    total: candidates.length,
    found: local,
    remaining: needsWebSearch.length,
  });
  onProgress({ step: "web_started", total: needsWebSearch.length });
  const searchResults = await webSearch(needsWebSearch, config);
  const webResults = searchResults
    .filter((result) => result.status === "found")
    .map((result) => ({
      candidate_id: result.candidate_id,
      quote: result.quote,
      url: result.url,
      sources: result.sources ?? [],
      searched_sources: result.searched_sources ?? [],
      verification_level: result.verification_level ?? "single_source",
    }));
  const withWeb = applyWebSearchResults(base, webResults);
  const stillUnresolved = needsWebSearch.filter(
    (c) => !webResults.some((r) => r.candidate_id === c.id)
  );
  onProgress({
    step: "web",
    total: needsWebSearch.length,
    found: webResults.length,
    notFound: searchResults.filter((result) => result.status === "not_found").length,
    error: searchResults.filter((result) => result.status === "error").length,
    remaining: stillUnresolved.length,
  });

  const knowledgeResults = stillUnresolved.length ? await modelKnowledge(stillUnresolved, config) : [];
  const searchById = new Map(searchResults.map((result) => [result.candidate_id, result]));
  for (const knowledge of knowledgeResults) {
    const search = searchById.get(knowledge.candidate_id);
    if (search?.status === "not_found") {
      const reason = search.reason ? `：${search.reason}` : "";
      knowledge.web_fallback_status = "not_found";
      knowledge.web_fallback_reason = search.reason || "未检出可靠来源";
      knowledge.quote = `[联网未检出${reason}]${knowledge.quote}`;
    }
    if (search?.status === "error") {
      const error = search.error || "联网调用失败";
      knowledge.web_fallback_status = "error";
      knowledge.web_fallback_reason = error;
      knowledge.quote = `[联网失败：${error}]${knowledge.quote}`;
    }
  }
  onProgress({ step: "model_knowledge", total: stillUnresolved.length, found: knowledgeResults.length });
  return [...withWeb, ...knowledgeResults];
}
