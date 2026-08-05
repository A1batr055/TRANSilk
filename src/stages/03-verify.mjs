import fs from "node:fs";
import path from "node:path";
import { callModel } from "../lib/modelClient.mjs";
import { termFields } from "../lib/language.mjs";
import { buildTermbaseIndex, lookupTerm } from "../lib/localTermbase.mjs";

// 联网证据必须由外部 Agent 注入；模型知识只能标记为无出处兜底。
function loadOverrides(projectDir) {
  const p = path.join(projectDir, "99_项目配置与术语源数据", "overrides.json");
  if (!fs.existsSync(p)) return {};
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

export function checkOverridesAndLocal(candidates, config, projectDir) {
  const { sourceField, targetField } = termFields(config);
  const overrides = loadOverrides(projectDir);
  const termbaseIndex = buildTermbaseIndex();
  const evidence = [];
  const needsWebSearch = [];

  for (const c of candidates) {
    if (overrides[c[sourceField]]) {
      const override = overrides[c[sourceField]];
      evidence.push({
        candidate_id: c.id,
        source: "local",
        quote: typeof override === "string" ? override : override[targetField],
        url: "",
      });
      continue;
    }
    const local = lookupTerm(termbaseIndex, config.sourceLanguage, c[sourceField], config.domain);
    if (local) {
      evidence.push({ candidate_id: c.id, source: "local", quote: local.targetTerm, url: "" });
      continue;
    }
    needsWebSearch.push(c);
  }

  return { evidence, needsWebSearch };
}

export function applyWebSearchResults(evidence, webResults) {
  return [...evidence, ...webResults.map((r) => ({ ...r, source: "web_search" }))];
}

export async function applyModelKnowledgeFallback(candidate, config) {
  const { sourceField, targetField } = termFields(config);
  const sourceLabel = config.sourceLabel || config.sourceLanguage;
  const targetLabel = config.targetLabel || config.targetLanguage;
  const result = await callModel({
    system:
      `你是术语查证助手。基于你的知识判断给定${sourceLabel}术语在指定领域下最恰当的${targetLabel}译法，` +
      "如果不确定就如实说不确定，不要编造出处。只输出JSON。",
    user:
      `领域：${config.domain}\n${sourceLabel}术语：${candidate[sourceField]}\n当前候选${targetLabel}译法：${candidate[targetField]}\n` +
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

export async function applyModelKnowledgeFallbackBatch(candidates, config, batchSize = 25) {
  const { sourceField, targetField } = termFields(config);
  const sourceLabel = config.sourceLabel || config.sourceLanguage;
  const targetLabel = config.targetLabel || config.targetLanguage;
  const results = [];
  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);
    const listed = batch
      .map((c) => `${c.id}｜${c[sourceField]}｜候选译法:${c[targetField]}`)
      .join("\n");
    const result = await callModel({
      system:
        `你是术语查证助手。基于你的知识逐条判断给定${sourceLabel}术语在指定领域下最恰当的${targetLabel}译法，` +
        "如果不确定就如实说不确定，不要编造出处。只输出JSON。",
      user:
        `领域：${config.domain}\n以下每行是一条候选术语(id｜${sourceLabel}｜当前候选${targetLabel}译法)：\n${listed}\n\n` +
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

export async function verifyCandidates(candidates, config, projectDir, { webResults = [] } = {}) {
  const { evidence: base, needsWebSearch } = checkOverridesAndLocal(candidates, config, projectDir);
  const withWeb = applyWebSearchResults(base, webResults);
  const stillUnresolved = needsWebSearch.filter(
    (c) => !webResults.some((r) => r.candidate_id === c.id)
  );

  const fallbacks = await applyModelKnowledgeFallbackBatch(stillUnresolved, config);
  return [...withWeb, ...fallbacks];
}
