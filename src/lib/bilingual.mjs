
const BLOCK_HEADER = /^\[([^\]]+)\]$/;

export function parseBilingualTxt(raw) {
  const blocks = raw.split(/\r?\n\r?\n+/).map((b) => b.trim()).filter(Boolean);
  return blocks.map((block) => {
    const lines = block.split(/\r?\n/);
    const header = lines[0]?.match(BLOCK_HEADER);
    if (!header) {
      throw new Error(`双语对照 txt 里有一块没有 [ID] 头：${block.slice(0, 40)}...`);
    }
    const [source, target] = lines.slice(1);
    if (source === undefined || target === undefined) {
      throw new Error(`句段 ${header[1]} 缺原文或译文行`);
    }
    return { id: header[1], source, target };
  });
}

export function writeBilingualTxt(segments) {
  return (
    segments
      .map((s) => `[${s.id}]\n${s.source}\n${s.target ?? ""}`)
      .join("\n\n") + "\n"
  );
}

export function assertIdSetMatches(segments, expectedIds) {
  const got = new Set(segments.map((s) => s.id));
  const want = new Set(expectedIds);
  const missing = [...want].filter((id) => !got.has(id));
  const extra = [...got].filter((id) => !want.has(id));
  if (missing.length > 0 || extra.length > 0) {
    const parts = [];
    if (missing.length) parts.push(`缺失：${missing.join("、")}`);
    if (extra.length) parts.push(`多出：${extra.join("、")}`);
    throw new Error(`双语对照 txt 的句段 ID 跟原文对不上——${parts.join("；")}`);
  }
}
