function normalizeUrl(value) {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return "";
    url.hash = "";
    return url.href.replace(/\/$/, "");
  } catch {
    return "";
  }
}

function stringValues(value, output = []) {
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value)) value.forEach((item) => stringValues(item, output));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => stringValues(item, output));
  return output;
}

function urlsIn(value) {
  const urls = new Set();
  for (const text of stringValues(value)) {
    for (const match of text.matchAll(/https?:\/\/[^\s<>"'）】]+/g)) {
      const url = normalizeUrl(match[0].replace(/[.,;:!?]+$/, ""));
      if (url) urls.add(url);
    }
  }
  return [...urls];
}

function sourceRecords(value, output = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => sourceRecords(item, output));
    return output;
  }
  if (!value || typeof value !== "object") return output;
  const url = normalizeUrl(value.url ?? value.link ?? value.uri);
  if (url) {
    output.push({
      url,
      title: String(value.title ?? value.name ?? "").trim(),
      excerpt: String(value.content ?? value.snippet ?? value.cited_text ?? value.text ?? "").trim(),
    });
  }
  Object.values(value).forEach((item) => sourceRecords(item, output));
  return output;
}

function uniqueSources(values) {
  const byUrl = new Map();
  for (const value of values) {
    for (const source of sourceRecords(value)) {
      const current = byUrl.get(source.url);
      if (!current || (!current.excerpt && source.excerpt)) byUrl.set(source.url, source);
    }
    for (const url of urlsIn(value)) {
      if (!byUrl.has(url)) byUrl.set(url, { url, title: "", excerpt: "" });
    }
  }
  return [...byUrl.values()];
}

function comparableText(value) {
  return String(value ?? "").replace(/\s+/g, "").toLocaleLowerCase();
}

export function responseTrace(body) {
  const output = body?.output ?? [];
  const calls = output.filter((item) => item?.type === "web_search_call");
  const annotations = output.flatMap((item) => item?.content ?? [])
    .flatMap((item) => item?.annotations ?? [])
    .filter((item) => item?.type === "url_citation");
  const failed = calls.some((item) => ["failed", "incomplete"].includes(item?.status));
  const returnedSources = calls.some((item) => Array.isArray(item?.action?.sources) && item.action.sources.length > 0);
  const completed = calls.some((item) => item?.status === "completed") ||
    (calls.length > 0 && !failed && (annotations.length > 0 || returnedSources));
  return {
    requested: calls.length > 0,
    completed,
    failed,
    error: failed ? "联网搜索工具未完成" : "",
    sources: uniqueSources([...calls.map((item) => item?.action?.sources ?? []), annotations]),
  };
}

export function anthropicTrace(body) {
  const content = body?.content ?? [];
  const uses = content.filter((item) => item?.type === "server_tool_use" && item?.name === "web_search");
  const useIds = new Set(uses.map((item) => item.id));
  const results = content.filter((item) => item?.type === "web_search_tool_result" && useIds.has(item?.tool_use_id));
  const failed = results.some((item) => item?.is_error ||
    (item?.content ?? []).some((part) => /error$/i.test(part?.type ?? "")));
  const annotations = content.filter((item) => item?.type === "text").flatMap((item) => item?.citations ?? []);
  return {
    requested: uses.length > 0,
    completed: results.length > 0 && !failed,
    failed,
    error: failed ? "联网搜索工具返回错误" : "",
    sources: uniqueSources([...results.map((item) => item.content), annotations]),
  };
}

function chatSearchRecords(body) {
  return [
    body?.search_result,
    body?.search_results,
    body?.search_info,
    body?.references,
    body?.choices?.[0]?.message?.annotations,
    body?.choices?.[0]?.message?.search_result,
    body?.choices?.[0]?.message?.search_results,
    body?.choices?.[0]?.message?.search_info,
    body?.output?.search_info,
  ].filter(Boolean);
}

export function chatTrace(body, mode) {
  const records = chatSearchRecords(body);
  const requestCount = Number(body?.usage?.server_tool_use?.web_search_requests ?? 0);
  const pipeline = body?.pipeline ?? body?.usage?.pipeline ?? [];
  const pipelineSignal = Array.isArray(pipeline) && pipeline.some((item) =>
    item?.type === "server_tools" && stringValues(item).some((text) => /web.search/i.test(text))
  );
  const explicitSignal = records.length > 0 || requestCount > 0 || pipelineSignal;
  const failed = Boolean(body?.search_error || body?.web_search_error);
  return {
    requested: explicitSignal,
    completed: explicitSignal && !failed,
    failed,
    error: failed ? String(body.search_error ?? body.web_search_error) : "",
    sources: uniqueSources(records),
    mode,
  };
}

export function cliTrace(toolUses, toolResults) {
  const useIds = new Set(toolUses.map((item) => item.id).filter(Boolean));
  const matchedResults = toolResults.filter((item) => !item.tool_use_id || useIds.has(item.tool_use_id));
  const failed = matchedResults.some((item) => item.is_error === true || /error|failed/i.test(item.status ?? ""));
  return {
    requested: toolUses.length > 0,
    completed: matchedResults.length > 0 && !failed,
    failed,
    error: failed ? "联网搜索工具返回错误" : "",
    sources: uniqueSources(matchedResults),
  };
}

export function validateGroundedResult(candidateId, claim, trace) {
  if (trace.failed) return { candidate_id: candidateId, status: "error", error: trace.error || "联网搜索失败" };
  if (!trace.requested) return { candidate_id: candidateId, status: "error", error: "没有检测到联网搜索工具调用" };
  if (!trace.completed) return { candidate_id: candidateId, status: "error", error: "检测到工具调用请求，但没有完成的搜索结果" };
  if (!claim) return { candidate_id: candidateId, status: "error", error: "联网查证响应缺少该术语" };
  if (claim.status === "not_found") {
    return { candidate_id: candidateId, status: "not_found", reason: String(claim.reason ?? "").trim() };
  }
  if (claim.status !== "found") return { candidate_id: candidateId, status: "error", error: `未知联网状态：${claim.status}` };
  const claimedEvidence = Array.isArray(claim.evidence) ? claim.evidence : [];
  if (!claimedEvidence.length) return { candidate_id: candidateId, status: "error", error: "联网结果缺少证据列表" };
  const trusted = new Map(trace.sources.map((item) => [item.url, item]));
  const selected = [];
  for (const item of claimedEvidence) {
    const url = normalizeUrl(item?.url);
    if (!url || !trusted.has(url)) {
      return { candidate_id: candidateId, status: "error", error: "模型返回的URL不在真实搜索结果或citation中" };
    }
    const quote = String(item?.quote ?? "").trim();
    if (!quote) return { candidate_id: candidateId, status: "error", error: "联网结果缺少依据摘录" };
    const trustedSource = trusted.get(url);
    const trustedExcerpt = comparableText(trustedSource.excerpt);
    if (trustedExcerpt && !trustedExcerpt.includes(comparableText(quote))) {
      return { candidate_id: candidateId, status: "error", error: "模型返回的依据摘录与真实搜索结果不符" };
    }
    selected.push({ ...trustedSource, quote });
  }
  const deduped = [...new Map(selected.map((item) => [item.url, item])).values()];
  const hosts = new Set(deduped.map((item) => new URL(item.url).hostname.replace(/^www\./, "")));
  return {
    candidate_id: candidateId,
    status: "found",
    quote: deduped.map((item) => item.quote).join("｜"),
    url: deduped[0].url,
    sources: deduped,
    searched_sources: trace.sources,
    verification_level: hosts.size >= 2 ? "cross_checked" : "single_source",
  };
}

export { normalizeUrl, uniqueSources };
