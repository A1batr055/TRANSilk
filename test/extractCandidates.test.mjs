import assert from "node:assert/strict";
import test from "node:test";
import { extractCandidates } from "../src/stages/02-extract.mjs";

const baseConfig = {
  sourceLanguage: "zh-CN",
  targetLanguage: "en-US",
  sourceTermField: "zh_CN",
  targetTermField: "en_US",
  domain: "法律",
  defaultTopic: "合同条款",
  sections: [],
};

const segments = [{ id: "S-0001", index: 1, text: "纳洛酮用于逆转阿片类药物过量。" }];

test("extractCandidates keeps a term's own domain when it's in the closed taxonomy", async () => {
  const fakeModelCall = async () => ({
    terms: [
      {
        zh_CN: "纳洛酮",
        en_US: "naloxone",
        part_of_speech: "名词",
        domain: "医学",
        definition: "阿片受体拮抗剂",
        note: "",
        source_segment_id: "S-0001",
      },
    ],
  });
  const candidates = await extractCandidates(segments, baseConfig, fakeModelCall);
  assert.equal(candidates[0].domain, "医学");
});

test("extractCandidates falls back to the document domain when the model's per-term domain isn't in the taxonomy", async () => {
  const fakeModelCall = async () => ({
    terms: [
      {
        zh_CN: "纳洛酮",
        en_US: "naloxone",
        part_of_speech: "名词",
        domain: "药理学（自造）",
        definition: "",
        note: "",
        source_segment_id: "S-0001",
      },
    ],
  });
  const candidates = await extractCandidates(segments, baseConfig, fakeModelCall);
  assert.equal(candidates[0].domain, "法律");
});
