function endpointFor({ protocol, baseURL }) {
  const base = baseURL.trim().replace(/\/+$/, "");
  if (!base) throw new Error("API base URL 不能为空");
  if (protocol === "anthropic") {
    const versionedBase = /\/v1$/i.test(base) ? base : `${base}/v1`;
    return `${versionedBase}/models?limit=1000`;
  }
  return `${base}/models`;
}

export async function listAvailableModels(config, fetchImpl = fetch) {
  if (config.protocol === "cli-agent") {
    return [];
  }
  const url = endpointFor(config);
  const headers = config.protocol === "anthropic"
    ? { "x-api-key": config.apiKey, "anthropic-version": "2023-06-01" }
    : { Authorization: `Bearer ${config.apiKey}` };
  const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(15000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`获取模型失败（HTTP ${response.status}）`);

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("模型接口返回了无效 JSON");
  }

  const models = [...new Set((body.data || []).map((item) => item?.id).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
  if (!models.length) throw new Error("模型接口没有返回可用模型");
  return models;
}
