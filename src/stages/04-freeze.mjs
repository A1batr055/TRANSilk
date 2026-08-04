import fs from "node:fs";
import { writeSimpleWorkbook, readSimpleWorkbook } from "../lib/xlsx.mjs";
import { termFields } from "../lib/language.mjs";


const DELETE_MARK = "删除";

export function reviewHeaders(config) {
  const sourceLabel = config?.sourceLabel || config?.sourceLanguage || "原文";
  const targetLabel = config?.targetLabel || config?.targetLanguage || "译文";
  return ["id", sourceLabel, `${targetLabel}译法`, "依据", "删除"];
}

function groupEvidence(evidence) {
  const map = new Map();
  for (const e of evidence) {
    if (!map.has(e.candidate_id)) map.set(e.candidate_id, []);
    map.get(e.candidate_id).push(e);
  }
  return map;
}

function bestEvidence(evidenceByCandidate, candidateId) {
  const list = evidenceByCandidate.get(candidateId) ?? [];
  const order = ["local", "web_search", "model_knowledge"];
  return list.slice().sort((a, b) => order.indexOf(a.source) - order.indexOf(b.source))[0];
}

function formatEvidence(ev) {
  if (!ev) return "（无出处）";
  const quote = (ev.quote ?? "").slice(0, 60);
  return `[${ev.source}] ${quote}`;
}

export async function exportCandidatesToWorkbook(candidates, evidence, workbookPath, config) {
  const evidenceByCandidate = groupEvidence(evidence);
  const headers = reviewHeaders(config);
  const { sourceField, targetField } = termFields(config);

  const rows = candidates.map((c) => [
    c.id,
    c[sourceField],
    c[targetField],
    formatEvidence(bestEvidence(evidenceByCandidate, c.id)),
    "",
  ]);

  const lastRow = rows.length + 1;
  const buffer = await writeSimpleWorkbook({
    sheetName: "候选术语审阅",
    headers,
    rows,
    dataValidations: [{ sqref: `E2:E${lastRow}`, list: [DELETE_MARK] }],
  });
  fs.writeFileSync(workbookPath, buffer);
  return workbookPath;
}

export async function importReviewedGlossary(workbookPath, candidates, evidence = []) {
  const buffer = fs.readFileSync(workbookPath);
  const { headers, rows } = await readSimpleWorkbook(buffer);
  const idx = (name) => headers.indexOf(name);
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const evidenceByCandidate = groupEvidence(evidence);

  return rows.map((row) => {
    const id = row[idx("id")];
    const original = byId.get(id) ?? {};
    const sourceField = original.sourceTermField || Object.keys(original).find((key) => key.includes("_") && !key.startsWith("source_")) || "zh_CN";
    const targetField = original.targetTermField || (sourceField === "zh_CN" ? "en_US" : "zh_CN");
    const sourceHeader = headers[1];
    const targetHeader = headers[2];
    const deleted = row[idx("删除")]?.trim() === DELETE_MARK;
    const best = bestEvidence(evidenceByCandidate, id);

    return {
      id,
      [sourceField]: row[idx(sourceHeader)],
      [targetField]: row[idx(targetHeader)],
      ...(sourceField === "zh_CN" || targetField === "zh_CN" ? { zh_CN: sourceField === "zh_CN" ? row[idx(sourceHeader)] : row[idx(targetHeader)] } : {}),
      ...(sourceField === "en_US" || targetField === "en_US" ? { en_US: sourceField === "en_US" ? row[idx(sourceHeader)] : row[idx(targetHeader)] } : {}),
      en_variants: [],
      part_of_speech: original.part_of_speech ?? "",
      domain: original.domain ?? "",
      status: deleted ? "弃用" : "首选",
      definition: original.definition ?? original.definition_zh ?? "",
      note: original.note ?? original.note_zh ?? "",
      definition_zh: original.definition_zh ?? original.definition ?? "",
      note_zh: original.note_zh ?? original.note ?? "",
      source_segment_id: original.source_segment_id ?? "",
      evidence_source: best?.source ?? "",
      evidence_quote: best?.quote ?? "",
    };
  });
}
