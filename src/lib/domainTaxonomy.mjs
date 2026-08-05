import fs from "node:fs";
import path from "node:path";
import { TOOL_ROOT } from "./paths.mjs";

export const PENDING_DOMAIN_LABEL = "待归类";

export function domainTaxonomyDir() {
  return path.join(TOOL_ROOT, "domain-taxonomy");
}

export function domainTaxonomyPath() {
  return path.join(domainTaxonomyDir(), "domains.jsonl");
}

export function pendingDomainsPath() {
  return path.join(domainTaxonomyDir(), "pending.jsonl");
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function appendJsonl(filePath, entry) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf8");
}

export function loadDomains() {
  return readJsonl(domainTaxonomyPath());
}

export function listDomainLabels() {
  return loadDomains().map((d) => d.label);
}

export function addDomain(label) {
  const trimmed = String(label ?? "").trim();
  if (!trimmed) throw new Error("领域名不能为空");
  const existing = listDomainLabels();
  if (existing.includes(trimmed)) return existing.length;
  appendJsonl(domainTaxonomyPath(), { label: trimmed });
  return existing.length + 1;
}

export function loadPendingDomains() {
  return readJsonl(pendingDomainsPath());
}

export function recordPendingDomain(suggestion, context = {}) {
  appendJsonl(pendingDomainsPath(), {
    suggestion: String(suggestion ?? "").trim(),
    title: context.title ?? "",
    date: context.date ?? new Date().toISOString().slice(0, 10),
  });
}
