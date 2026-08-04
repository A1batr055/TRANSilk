import { readDocumentParagraphs } from "./docReader.mjs";
import { splitSentences } from "./sentenceSplit.mjs";
import { segmentId } from "./segment.mjs";

export async function ingestRawDocument({ sourcePath, targetPath, segmentPrefix }) {
  const sourceParagraphs = await readDocumentParagraphs(sourcePath);

  if (targetPath) {
    const targetParagraphs = await readDocumentParagraphs(targetPath);
    if (sourceParagraphs.length !== targetParagraphs.length) {
      throw new Error(
        `原文与既有译文段落数不一致，无法按段落对齐：` +
          `${sourcePath} 共 ${sourceParagraphs.length} 段，` +
          `${targetPath} 共 ${targetParagraphs.length} 段。请人工核对两份文档是否真正对应。`
      );
    }
    const segments = sourceParagraphs.map((text, i) => ({
      id: segmentId(segmentPrefix, i + 1),
      index: i + 1,
      text,
      target: targetParagraphs[i],
    }));
    return { segments, sections: [{ start: 1 }] };
  }

  const segments = [];
  let index = 0;
  for (const paragraph of sourceParagraphs) {
    for (const sentence of splitSentences(paragraph)) {
      index += 1;
      segments.push({
        id: segmentId(segmentPrefix, index),
        index,
        text: sentence,
        target: "",
      });
    }
  }
  return { segments, sections: [{ start: 1 }] };
}
