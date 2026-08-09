import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  acceptPendingDomain,
  addDomain,
  dismissPendingDomain,
  listDomainLabels,
  loadPendingDomains,
} from "../src/lib/domainTaxonomy.mjs";
import { RUNTIME_TEMP_ROOT } from "../src/lib/paths.mjs";

function fixture() {
  fs.mkdirSync(RUNTIME_TEMP_ROOT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(RUNTIME_TEMP_ROOT, "transilk-domain-test-"));
  const seedPath = path.join(dir, "domains.jsonl");
  const localPath = path.join(dir, "domains.local.jsonl");
  const pendingPath = path.join(dir, "pending.jsonl");
  fs.writeFileSync(seedPath, '{"label":"法律"}\n', "utf8");
  fs.writeFileSync(localPath, '{"label":"财经"}\n', "utf8");
  fs.writeFileSync(pendingPath,
    '{"suggestion":"医学","title":"项目甲","date":"2026-08-09"}\n' +
    '{"suggestion":"医学","title":"项目乙","date":"2026-08-09"}\n' +
    '{"suggestion":"能源","title":"项目丙","date":"2026-08-09"}\n',
    "utf8");
  return { dir, seedPath, localPath, pendingPath };
}

test("accepting a pending domain promotes it and removes only the reviewed record", () => {
  const paths = fixture();
  try {
    const result = acceptPendingDomain(0, paths);
    assert.equal(result.entry.suggestion, "医学");
    assert.deepEqual(listDomainLabels(paths), ["法律", "财经", "医学"]);
    assert.deepEqual(loadPendingDomains(paths.pendingPath).map((entry) => entry.suggestion), ["医学", "能源"]);
  } finally {
    fs.rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("dismissing a pending domain removes only the selected record", () => {
  const paths = fixture();
  try {
    const removed = dismissPendingDomain(2, paths);
    assert.equal(removed.suggestion, "能源");
    assert.deepEqual(loadPendingDomains(paths.pendingPath).map((entry) => entry.suggestion), ["医学", "医学"]);
  } finally {
    fs.rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("pending suggestions can be renamed before acceptance", () => {
  const paths = fixture();
  try {
    const result = acceptPendingDomain(0, { ...paths, label: "医疗" });
    assert.equal(result.label, "医疗");
    assert.deepEqual(listDomainLabels(paths), ["法律", "财经", "医疗"]);
    assert.deepEqual(loadPendingDomains(paths.pendingPath).map((entry) => entry.suggestion), ["医学", "能源"]);
  } finally {
    fs.rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("duplicate acceptance fails and preserves the pending record", () => {
  const paths = fixture();
  try {
    assert.throws(() => acceptPendingDomain(0, { ...paths, label: "财经" }), /已存在/);
    assert.deepEqual(loadPendingDomains(paths.pendingPath).map((entry) => entry.suggestion), ["医学", "医学", "能源"]);
    assert.throws(() => addDomain("财经", paths), /已存在/);
  } finally {
    fs.rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("malformed direct edits report the exact JSONL line", () => {
  const paths = fixture();
  try {
    fs.appendFileSync(paths.localPath, "not-json\n", "utf8");
    assert.throws(() => listDomainLabels(paths), /第 2 行不是合法 JSON/);
  } finally {
    fs.rmSync(paths.dir, { recursive: true, force: true });
  }
});
