
const JSON_INSTRUCTION =
  "\n\n只输出合法 JSON，不要任何解释文字，不要用 markdown 代码围栏包裹。";

function stripCodeFence(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1] : trimmed;
}

export async function callAnthropic({ baseURL, model, apiKey }, { system, user, json = false, temperature = 0.2 }) {
  const res = await fetch(`${baseURL}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      system: json ? `${system}${JSON_INSTRUCTION}` : system,
      messages: [{ role: "user", content: user }],
      temperature,
      max_tokens: 8192,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`模型调用失败 ${res.status}: ${text}`);
  }

  const data = await res.json();
  const content = data.content?.[0]?.text ?? "";
  return json ? JSON.parse(stripCodeFence(content)) : content;
}
