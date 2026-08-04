import fs from "node:fs";
import { termFields } from "../lib/language.mjs";


function normalizeText(s) {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

export function pickTermFields(config) {
  const { sourceField, targetField } = termFields(config);
  return { termField: sourceField, realizationField: targetField, variantsField: `${targetField}_variants` };
}

export function checkRealization(glossary, segments, config) {
  const { termField, realizationField, variantsField } = pickTermFields(config);
  const bySegmentId = new Map(segments.map((s) => [s.id, s]));
  const report = [];

  for (const term of glossary) {
    if (term.status && term.status !== "首选") continue;
    const segment = bySegmentId.get(term.source_segment_id);
    if (!segment) continue;

    const termText = term[termField];
    if (!segment.source.includes(termText)) continue;

    const variants = term[variantsField] ?? (realizationField === "en_US" ? term.en_variants : term.zh_variants) ?? [];
    const wanted = [term[realizationField], ...variants].filter(Boolean);
    const found = wanted.some((w) => normalizeText(segment.target).includes(normalizeText(w)));

    if (!found) {
      report.push({
        term_id: term.id,
        segment_id: segment.id,
        expected: term[realizationField],
        expected_variants: variants,
        code: "TERM_NOT_REALIZED",
      });
    }
  }
  return report;
}

export function writeCheckReport(workDir, report) {
  const p = `${workDir}/check-report.json`;
  fs.writeFileSync(p, JSON.stringify(report, null, 2) + "\n", "utf8");
  return p;
}
