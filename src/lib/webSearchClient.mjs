import { lookup } from "node:dns/promises";
import fs from "node:fs";
import net from "node:net";
import { readModelConfig } from "./configWizard.mjs";
import { termFields } from "./language.mjs";
import { runtimeTempDir } from "./paths.mjs";
import { runCliProcess } from "./cliProcess.mjs";
import {
  anthropicTrace,
  chatTrace,
  cliTrace,
  normalizeUrl,
  responseTrace,
  uniqueSources,
  validateGroundedResult,
} from "./webSearchSignals.mjs";

const JSON_SUFFIX = "\n\n只输出合法JSON，不要解释，不要使用Markdown代码围栏。";
const SEARCH_SYSTEM = "你是术语联网查证器。必须实际使用服务器端联网搜索工具，优先查找权威一手来源；需要时使用多个独立来源交叉查证。不得编造搜索行为、来源、URL或摘录。";

function stripFence(value) {
  const text = String(value ?? "").trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1] : text;
}

function parseClaims(value) {
  const parsed = JSON.parse(stripFence(value));
  if (!Array.isArray(parsed?.results)) throw new Error("联网查证响应缺少results数组");
  return parsed.results;
}

function promptFor(candidates, config) {
  const { sourceField, targetField } = termFields(config);
  const listed = candidates.map((candidate) => ({
    id: candidate.id,
    domain: candidate.domain || config.domain,
    source_term: candidate[sourceField],
    current_target: candidate[targetField],
  }));
  return `逐条联网查证术语译法。每条都必须实际调用Web Search。优先使用官方术语表、标准或机构双语页面；一个来源不足以确定时，使用多个独立来源交叉查证。\n` +
    `输入：${JSON.stringify(listed)}\n` +
    `输出：{"results":[{"id":"...","status":"found|not_found","evidence":[{"quote":"页面中的简短依据","url":"https://..."}],"reason":"未检出或证据冲突的简短原因"}]}。` +
    `found至少包含一条真实证据；not_found的evidence为空。${JSON_SUFFIX}`;
}

function endpoint(baseURL, suffix) {
  return `${String(baseURL ?? "").trim().replace(/\/+$/, "")}/${suffix}`;
}

async function jsonResponse(fetchImpl, url, request, label) {
  const response = await fetchImpl(url, { ...request, signal: AbortSignal.timeout(120000) });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${label}返回了无效JSON（HTTP ${response.status}）`);
  }
  if (!response.ok) throw new Error(`${label}失败（HTTP ${response.status}）：${body?.error?.message || body?.message || "未知错误"}`);
  return body;
}

function bearerHeaders(apiKey) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
}

function responseText(body) {
  return (body?.output ?? []).flatMap((item) => item?.content ?? [])
    .filter((item) => item?.type === "output_text")
    .map((item) => item.text).join("");
}

function chatText(body) {
  return body?.choices?.[0]?.message?.content ?? "";
}

function anthropicText(body) {
  return (body?.content ?? []).filter((item) => item?.type === "text").map((item) => item.text).join("");
}

function validateSingle(candidate, claimText, trace) {
  const claim = parseClaims(claimText).find((item) => item?.id === candidate.id);
  return validateGroundedResult(candidate.id, claim, trace);
}

function privateAddress(address) {
  const value = String(address ?? "").toLowerCase();
  if (net.isIPv4(value)) {
    const parts = value.split(".").map(Number);
    return parts[0] === 0 || parts[0] === 10 || parts[0] === 127 ||
      (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) || parts[0] >= 224;
  }
  if (net.isIPv6(value)) {
    return value === "::1" || value === "::" || value.startsWith("fc") || value.startsWith("fd") ||
      value.startsWith("fe8") || value.startsWith("fe9") || value.startsWith("fea") || value.startsWith("feb") ||
      value.startsWith("::ffff:127.") || value.startsWith("::ffff:10.") || value.startsWith("::ffff:192.168.");
  }
  return true;
}

async function assertPublicPageUrl(value, lookupImpl) {
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("CLI返回了不安全的来源URL");
  if (url.port && !["80", "443"].includes(url.port)) throw new Error("CLI来源URL使用了非标准端口");
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) throw new Error("CLI来源URL指向本机或内网");
  const addresses = net.isIP(host) ? [{ address: host }] : await lookupImpl(host, { all: true });
  if (!addresses.length || addresses.some((item) => privateAddress(item.address))) throw new Error("CLI来源URL指向本机或内网");
  return url.href;
}

function pageText(value) {
  return String(value ?? "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function comparablePageText(value) {
  return pageText(value).replace(/\s+/g, "").toLocaleLowerCase();
}

async function fetchCliSource(evidence, fetchImpl, lookupImpl, pageCache) {
  const url = await assertPublicPageUrl(evidence?.url, lookupImpl);
  let pagePromise = pageCache.get(url);
  if (!pagePromise) {
    pagePromise = (async () => {
      const response = await fetchImpl(url, {
        headers: { "User-Agent": "TRANSilk/0.1 terminology-verification" },
        redirect: "error",
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const contentLength = Number(response.headers?.get?.("content-length") ?? 0);
      if (contentLength > 5 * 1024 * 1024) throw new Error("页面过大");
      const text = await response.text();
      if (text.length > 5 * 1024 * 1024) throw new Error("页面过大");
      return comparablePageText(text);
    })();
    pageCache.set(url, pagePromise);
  }
  const quote = String(evidence?.quote ?? "").trim();
  if (!quote || !(await pagePromise).includes(comparablePageText(quote))) throw new Error("页面中未找到依据摘录");
  return { url, title: "", excerpt: quote };
}

function queryCoversCandidate(candidate, config, queries) {
  const { sourceField, targetField } = termFields(config);
  const terms = [candidate[sourceField], candidate[targetField]]
    .map((value) => String(value ?? "").normalize("NFKC").trim().toLocaleLowerCase())
    .filter(Boolean);
  return queries.some((query) => {
    const normalized = String(query).normalize("NFKC").toLocaleLowerCase();
    return terms.some((term) => normalized.includes(term));
  });
}

async function validateCliBatch(candidates, config, claimText, trace, fetchImpl, lookupImpl) {
  const claims = new Map(parseClaims(claimText).map((claim) => [claim?.id, claim]));
  const trustedByUrl = new Map(trace.sources.map((source) => [normalizeUrl(source.url), source]));
  const pageCache = new Map();
  return Promise.all(candidates.map(async (candidate) => {
    const claim = claims.get(candidate.id);
    if (claim?.status === "not_found" && !queryCoversCandidate(candidate, config, trace.queries ?? [])) {
      return { candidate_id: candidate.id, status: "error", error: "没有检测到该术语对应的已完成搜索查询" };
    }
    if (!trace.requested || !trace.completed || trace.failed || claim?.status !== "found") {
      return validateGroundedResult(candidate.id, claim, trace);
    }
    try {
      const evidence = Array.isArray(claim.evidence) ? claim.evidence : [];
      if (evidence.length > 5) throw new Error("单条术语的来源超过5项");
      const fetchedSources = await Promise.all(evidence.map((item) => {
        const trusted = trustedByUrl.get(normalizeUrl(item?.url));
        return trusted?.excerpt ? trusted : fetchCliSource(item, fetchImpl, lookupImpl, pageCache);
      }));
      return validateGroundedResult(candidate.id, claim, {
        ...trace,
        sources: uniqueSources([trace.sources, fetchedSources]),
      });
    } catch (error) {
      return { candidate_id: candidate.id, status: "error", error: `CLI来源页面无法核验：${error.message}` };
    }
  }));
}

async function searchOneWithResponses(candidate, config, provider, fetchImpl) {
  const body = await jsonResponse(fetchImpl, endpoint(provider.baseURL, "responses"), {
    method: "POST",
    headers: bearerHeaders(provider.apiKey),
    body: JSON.stringify({
      model: provider.model,
      instructions: SEARCH_SYSTEM,
      tools: [{ type: "web_search" }],
      tool_choice: { type: "web_search" },
      input: promptFor([candidate], config),
    }),
  }, "Responses联网查证");
  return validateSingle(candidate, responseText(body), responseTrace(body));
}

async function searchOneWithAnthropic(candidate, config, provider, fetchImpl) {
  const base = String(provider.baseURL ?? "").trim().replace(/\/+$/, "");
  const body = await jsonResponse(fetchImpl, `${/\/v1$/i.test(base) ? base : `${base}/v1`}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": provider.apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: provider.model,
      max_tokens: 8192,
      system: SEARCH_SYSTEM,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 4 }],
      tool_choice: { type: "tool", name: "web_search" },
      messages: [{ role: "user", content: promptFor([candidate], config) }],
    }),
  }, "Anthropic联网查证");
  return validateSingle(candidate, anthropicText(body), anthropicTrace(body));
}

function chatMode(provider) {
  if (provider.webSearchMode) return provider.webSearchMode;
  const base = String(provider.baseURL ?? "").toLowerCase();
  if (base.includes("bigmodel.cn")) return "zhipu";
  if (base.includes("dashscope.aliyuncs.com")) {
    return /qwen3(?:\.5|\.6|\.7|-max)/i.test(provider.model ?? "") ? "" : "qwen";
  }
  if (base.includes("openrouter.ai")) return "openrouter";
  return "";
}

function chatSearchBody(mode, provider, prompt) {
  const body = {
    model: provider.model,
    messages: [
      { role: "system", content: SEARCH_SYSTEM },
      { role: "user", content: prompt },
    ],
  };
  if (mode === "zhipu") {
    body.tools = [{ type: "web_search", web_search: { enable: true, search_result: true, search_engine: "search_pro", count: 10, content_size: "high" } }];
  } else if (mode === "qwen") {
    body.enable_search = true;
    body.search_options = { forced_search: true, enable_source: true, enable_citation: true };
  } else if (mode === "openrouter") {
    body.tools = [{ type: "openrouter:web_search", parameters: { max_results: 10, max_total_results: 20 } }];
    body.tool_choice = "required";
  }
  return body;
}

async function searchOneWithChat(candidate, config, provider, mode, fetchImpl) {
  const body = await jsonResponse(fetchImpl, endpoint(provider.baseURL, "chat/completions"), {
    method: "POST",
    headers: bearerHeaders(provider.apiKey),
    body: JSON.stringify(chatSearchBody(mode, provider, promptFor([candidate], config))),
  }, `${mode}联网查证`);
  return validateSingle(candidate, chatText(body), chatTrace(body, mode));
}

function errorsFor(candidates, error) {
  const message = error instanceof Error ? error.message : String(error);
  return candidates.map((candidate) => ({ candidate_id: candidate.id, status: "error", error: message }));
}

async function mapCandidates(candidates, searchOne) {
  const results = [];
  for (const candidate of candidates) {
    try {
      results.push(await searchOne(candidate));
    } catch (error) {
      results.push(...errorsFor([candidate], error));
    }
  }
  return results;
}

function run(command, args, input, cwd, timeoutMs = 300000) {
  return runCliProcess(command, args, {
    cwd,
    input,
    timeoutMs,
    errorLabel: `${command}联网查证`,
  });
}

function jsonLines(text) {
  return String(text).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

async function searchBatchWithCodex(candidates, config, provider, runImpl, fetchImpl, lookupImpl) {
  const scratch = runtimeTempDir("web-codex");
  try {
    const args = ["--search", "exec", "--skip-git-repo-check", "--sandbox", "read-only", "--ephemeral", "--json", "-C", scratch];
    if (provider.model) args.push("-m", provider.model);
    if (provider.effort) args.push("-c", `model_reasoning_effort=${provider.effort}`);
    args.push("-");
    const events = jsonLines(await runImpl("codex", args, `${SEARCH_SYSTEM}\n\n${promptFor(candidates, config)}`, scratch, 300000));
    const searchEvents = events.filter((event) => /web_search/i.test(event?.item?.type ?? ""));
    const uses = searchEvents.map((event) => ({ ...event.item, id: event.item?.id ?? event.id }));
    const results = searchEvents
      .filter((event) => event?.type === "item.completed" || event?.item?.status === "completed")
      .map((event) => ({ ...event.item, tool_use_id: event.item?.id ?? event.id }));
    const finalText = [...events].reverse().find((event) => event?.item?.type === "agent_message")?.item?.text;
    return validateCliBatch(candidates, config, finalText, cliTrace(uses, results), fetchImpl, lookupImpl);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

async function searchBatchWithClaude(candidates, config, provider, runImpl, fetchImpl, lookupImpl) {
  const scratch = runtimeTempDir("web-claude");
  try {
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--allowedTools", "WebSearch,WebFetch", "--system-prompt", SEARCH_SYSTEM];
    if (provider.model) args.push("--model", provider.model);
    if (provider.effort) args.push("--effort", provider.effort);
    const events = jsonLines(await runImpl("claude", args, promptFor(candidates, config), scratch, 300000));
    const content = events.flatMap((event) => event?.message?.content ?? []);
    const uses = content.filter((item) => item?.type === "tool_use" && /WebSearch|WebFetch/i.test(item.name));
    const results = content.filter((item) => item?.type === "tool_result");
    const finalText = [...events].reverse().find((event) => event?.type === "result")?.result;
    return validateCliBatch(candidates, config, finalText, cliTrace(uses, results), fetchImpl, lookupImpl);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

async function searchOpenAICompatible(candidates, config, provider, fetchImpl) {
  const base = String(provider.baseURL ?? "").toLowerCase();
  if (base.includes("api.deepseek.com") && /deepseek-v4-pro/i.test(provider.model ?? "")) {
    const deepseekRoot = String(provider.baseURL).replace(/\/+$/, "").replace(/\/v1$/i, "");
    const anthropicProvider = {
      ...provider,
      baseURL: `${deepseekRoot}/anthropic`,
    };
    return mapCandidates(candidates, (candidate) => searchOneWithAnthropic(candidate, config, anthropicProvider, fetchImpl));
  }
  const mode = chatMode(provider);
  if (mode) return mapCandidates(candidates, (candidate) => searchOneWithChat(candidate, config, provider, mode, fetchImpl));
  return mapCandidates(candidates, (candidate) => searchOneWithResponses(candidate, config, provider, fetchImpl));
}

export async function searchWebEvidence(candidates, config, {
  secrets = readModelConfig(),
  fetchImpl = fetch,
  runImpl = run,
  lookupImpl = lookup,
} = {}) {
  if (!candidates.length) return [];
  const providerKey = secrets?.provider;
  const provider = secrets?.[providerKey];
  if (!provider) return errorsFor(candidates, new Error("没有可用的模型服务商配置"));
  if (provider.protocol === "cli-agent" && provider.cli === "codex") {
    try {
      return await searchBatchWithCodex(candidates, config, provider, runImpl, fetchImpl, lookupImpl);
    } catch (error) {
      return errorsFor(candidates, error);
    }
  }
  if (provider.protocol === "cli-agent" && provider.cli === "claude") {
    try {
      return await searchBatchWithClaude(candidates, config, provider, runImpl, fetchImpl, lookupImpl);
    } catch (error) {
      return errorsFor(candidates, error);
    }
  }
  if (provider.protocol === "anthropic") {
    return mapCandidates(candidates, (candidate) => searchOneWithAnthropic(candidate, config, provider, fetchImpl));
  }
  if (provider.protocol === "openai-compatible") return searchOpenAICompatible(candidates, config, provider, fetchImpl);
  return errorsFor(candidates, new Error(`当前接口协议“${provider.protocol}”没有可验证的联网处理器`));
}

export { validateGroundedResult, responseTrace, anthropicTrace, chatTrace, cliTrace, uniqueSources };
