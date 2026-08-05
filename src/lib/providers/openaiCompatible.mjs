
export async function callOpenAICompatible({ baseURL, model, apiKey }, { system, user, json = false, temperature = 0.2 }) {
  const body = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature,
  };
  if (json) body.response_format = { type: "json_object" };

  const res = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`模型调用失败 ${res.status}: ${text}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content ?? "";
  if (!json) return content;
  try {
    return JSON.parse(content);
  } catch (error) {
    const preview = content ? (content.length > 300 ? `${content.slice(0, 300)}…` : content) : "（空响应）";
    throw new Error(`模型返回的内容不是合法JSON（${error.message}），可能是响应抖动，可重跑当前命令重试：${preview}`);
  }
}
