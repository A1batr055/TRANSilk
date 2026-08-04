
const CJK_ENDERS = /[。！？]/;
const CJK_TRAILING = /[」』"'’”)）]/;

const EN_ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st",
  "vs", "etc", "e.g", "i.e", "fig", "no", "approx",
]);

function splitChinese(text) {
  const sentences = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (CJK_ENDERS.test(text[i])) {
      let end = i + 1;
      while (end < text.length && CJK_TRAILING.test(text[end])) end++;
      sentences.push(text.slice(start, end).trim());
      start = end;
      i = end - 1;
    }
  }
  if (start < text.length) sentences.push(text.slice(start).trim());
  return sentences.filter(Boolean);
}

function splitEnglish(text) {
  const sentences = [];
  let start = 0;
  const enderRe = /[.!?]+(["')\]]*)(\s+|$)/g;
  let match;
  while ((match = enderRe.exec(text)) !== null) {
    const end = match.index + match[0].length;
    const candidate = text.slice(start, end).trim();
    if (match[0].startsWith(".")) {
      const lastWord = candidate.split(/\s+/).pop().replace(/[.!?"')\]]+$/, "").toLowerCase();
      if (EN_ABBREVIATIONS.has(lastWord)) continue;
    }
    sentences.push(candidate);
    start = end;
  }
  if (start < text.length) sentences.push(text.slice(start).trim());
  return sentences.filter(Boolean);
}

export function splitSentences(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  return /[一-鿿]/.test(trimmed) ? splitChinese(trimmed) : splitEnglish(trimmed);
}
