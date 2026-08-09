import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Text, render, useApp, useInput, useWindowSize } from "ink";
import { TOOL_ROOT } from "./lib/paths.mjs";
import { deleteProject, inspectProject, listProjects, normalizeInputPath, projectDirForTitle } from "./lib/tuiState.mjs";
import { clearModelConfig, hasModelConfig, modelConfigSummary, MODEL_PRESETS, readModelConfig, saveModelConfig } from "./lib/configWizard.mjs";
import { listAvailableModels } from "./lib/modelCatalog.mjs";
import { formatEvidenceSummary } from "./lib/evidenceSummary.mjs";
import { LANGUAGE_OPTIONS } from "./lib/language.mjs";
import {
  acceptPendingDomain,
  addDomain,
  dismissPendingDomain,
  domainTaxonomyLocalPath,
  domainTaxonomyPath,
  ensureDomainTaxonomyFiles,
  listDomainLabels,
  loadPendingDomains,
  pendingDomainsPath,
} from "./lib/domainTaxonomy.mjs";
import { autoCheckForUpdates, checkForUpdates } from "./lib/selfUpdate.mjs";
import { listMountedTermbases, unmountExternalTermbase } from "./lib/localTermbase.mjs";
import { ensureProjectOverridesWorkbook } from "./lib/projectOverrides.mjs";

const h = React.createElement;
const CLI_PATH = path.join(TOOL_ROOT, "src", "cli.mjs");

function Frame({ title, subtitle, children }) {
  const { columns } = useWindowSize();
  const width = Math.max(24, Math.min(82, columns - 2));
  return h(
    Box,
    { flexDirection: "column", borderStyle: "round", borderColor: "cyan", paddingX: 1, width },
    h(Box, { justifyContent: "space-between" },
      h(Text, { bold: true, color: "cyan" }, title),
      subtitle ? h(Text, { dimColor: true }, subtitle) : null,
    ),
    h(Box, { flexDirection: "column", marginTop: 1 }, children),
  );
}

function Hint({ children }) {
  return h(Box, { marginTop: 1 }, h(Text, { dimColor: true }, children));
}

function Menu({ items, onSelect, onBack, initialIndex = 0, maxVisible = 12 }) {
  const [index, setIndex] = useState(Math.min(initialIndex, Math.max(items.length - 1, 0)));
  const start = Math.max(0, Math.min(index - Math.floor(maxVisible / 2), items.length - maxVisible));
  const visibleItems = items.slice(start, start + maxVisible);

  useInput((input, key) => {
    if (key.upArrow || input === "k") setIndex((value) => (value - 1 + items.length) % items.length);
    if (key.downArrow || input === "j") setIndex((value) => (value + 1) % items.length);
    if (key.return && items[index]) onSelect(items[index]);
    if (key.escape && onBack) onBack();
  });

  return h(
    Box,
    { flexDirection: "column" },
    start > 0 ? h(Text, { dimColor: true }, `  ↑ 还有 ${start} 项`) : null,
    ...visibleItems.map((item, visibleIndex) => {
      const itemIndex = start + visibleIndex;
      return (
      h(
        Text,
        { key: item.value, color: itemIndex === index ? "cyan" : undefined, bold: itemIndex === index },
        `${itemIndex === index ? "›" : " "} ${item.label}`,
      )
      );
    }),
    start + visibleItems.length < items.length
      ? h(Text, { dimColor: true }, `  ↓ 还有 ${items.length - start - visibleItems.length} 项`)
      : null,
  );
}

function LanguagePicker({ title, options, onSelect, onManual, onBack }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const filtered = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase("zh-CN");
    return options.filter(([code, name]) => !keyword || `${name} ${code}`.toLocaleLowerCase("zh-CN").includes(keyword));
  }, [options, query]);
  const items = [
    ...filtered.map(([code, name]) => [code, `${name}（${code}）`]),
    ["__manual__", "手动输入语言代码"],
  ];

  useEffect(() => setIndex(0), [query]);
  useInput((input, key) => {
    if (key.upArrow) return setIndex((value) => (value - 1 + items.length) % items.length);
    if (key.downArrow) return setIndex((value) => (value + 1) % items.length);
    if (key.return && items[index]) {
      if (items[index][0] === "__manual__") return onManual();
      return onSelect(items[index][0]);
    }
    if (key.escape) return onBack();
    if (key.backspace || key.delete) return setQuery((value) => Array.from(value).slice(0, -1).join(""));
    if (key.ctrl && input === "u") return setQuery("");
    if (input && !key.ctrl && !key.meta && !key.tab) setQuery((value) => value + input);
  });

  const visible = items.slice(Math.max(0, Math.min(index - 4, items.length - 10)), Math.max(0, Math.min(index - 4, items.length - 10)) + 10);
  const start = Math.max(0, Math.min(index - 4, items.length - 10));
  return h(
    Frame,
    { title, subtitle: `${items.length} 个选项` },
    h(Box, { marginBottom: 1 }, h(Text, { bold: true }, "搜索："), query ? h(Text, { color: "cyan" }, query) : h(Text, { dimColor: true }, "输入中文、英文名或语言代码")),
    h(Box, { flexDirection: "column" },
      ...visible.map((item, offset) => {
        const itemIndex = start + offset;
        return h(Text, { key: item[0], color: itemIndex === index ? "cyan" : undefined, bold: itemIndex === index }, `${itemIndex === index ? "›" : " "} ${item[1]}`);
      }),
    ),
    h(Hint, null, "输入搜索 · ↑↓ 选择 · Enter 确认 · Ctrl+U 清空 · Esc 返回"),
  );
}

function TextEntry({ label, initial = "", placeholder = "", secret = false, optional = false, onSubmit, onBack }) {
  const [value, setValue] = useState(initial);

  useInput((input, key) => {
    if (key.escape) return onBack();
    if (key.return) return onSubmit(value);
    if (key.backspace || key.delete) {
      setValue((current) => Array.from(current).slice(0, -1).join(""));
      return;
    }
    if (key.ctrl && input === "u") {
      setValue("");
      return;
    }
    if (input && !key.ctrl && !key.meta && !key.tab) setValue((current) => current + input);
  });

  const shown = secret ? "•".repeat(Array.from(value).length) : value;
  return h(
    Box,
    { flexDirection: "column" },
    h(Text, { bold: true }, label),
    h(Box, { marginTop: 1 },
      h(Text, { color: "cyan" }, "› "),
      shown ? h(Text, null, shown) : h(Text, { dimColor: true }, placeholder),
    ),
    h(Hint, null, optional ? "Enter 跳过 · Esc 返回" : "Enter 确认 · Esc 返回"),
  );
}

function Running({ task }) {
  return h(
    Frame,
    { title: "TRANSilk", subtitle: task.label },
    h(Text, { color: "yellow" }, "● 正在执行，请稍候……"),
    h(Box, { flexDirection: "column", marginTop: 1 },
      ...task.lines.map((line, index) => h(Text, { key: `${index}-${line}`, dimColor: true }, line)),
    ),
  );
}

function Home({ projectCount, model, notice, onCreate, onProjects, onModelSettings, onOtherSettings }) {
  const items = [
    { value: "new", label: "＋ 新建翻译项目" },
    { value: "projects", label: `项目列表  ·  ${projectCount} 个` },
    { value: "model-settings", label: `模型设置  ·  ${model.label}` },
    { value: "other-settings", label: "其他设置" },
  ];

  return h(
    Frame,
    { title: "TRANSilk", subtitle: "多语言翻译 · A1batr055" },
    notice ? h(Box, { marginBottom: 1 }, h(Text, { color: notice.kind === "error" ? "red" : notice.kind === "pending" ? "yellow" : "green" }, notice.text)) : null,
    h(Menu, {
      items,
      onSelect: (item) => {
        if (item.value === "new") onCreate();
        else if (item.value === "projects") onProjects();
        else if (item.value === "model-settings") onModelSettings();
        else if (item.value === "other-settings") onOtherSettings();
      },
    }),
    h(Hint, null, "↑↓ 选择 · Enter 确认 · Ctrl+C 退出"),
  );
}

function ImportTermbasePath({ onSubmit, onBack }) {
  return h(
    Frame,
    { title: "挂载外部术语库", subtitle: "TBX 文件或目录" },
    h(TextEntry, {
      label: "TBX 文件或所在目录的路径",
      placeholder: "可把文件或文件夹拖进终端",
      onSubmit,
      onBack,
    }),
  );
}

export function ExternalTermbasesScreen({ mounts, notice, onMount, onUnmount, onBack }) {
  const items = [
    { value: "mount", label: "＋ 挂载 TBX 文件或目录" },
    ...mounts.map((mount) => ({
      value: `unmount:${mount.id}`,
      label: `移除挂载 · ${mount.name} · ${mount.available ? `${mount.entryCount} 条` : "文件缺失"}`,
    })),
  ];
  return h(
    Frame,
    { title: "外部术语库", subtitle: `${mounts.length} 个挂载` },
    notice ? h(Box, { marginBottom: 1 }, h(Text, { color: notice.kind === "error" ? "red" : "green" }, notice.text)) : null,
    h(Menu, {
      items,
      onBack,
      onSelect: (item) => item.value === "mount" ? onMount() : onUnmount(item.value.slice("unmount:".length)),
    }),
    h(Hint, null, "外部文件由用户手动挂载；移除挂载不会删除原文件 · Esc 返回"),
  );
}

export function ModelSettingsScreen({ model, notice, onSelectModel, onConfigure, onClearConfig, onBack }) {
  return h(
    Frame,
    { title: "模型设置", subtitle: model.label },
    notice ? h(Box, { marginBottom: 1 }, h(Text, { color: notice.kind === "error" ? "red" : "green" }, notice.text)) : null,
    h(Menu, {
      items: [
        { value: "select", label: model.configured ? `选择模型  ·  ${model.label}` : "配置模型" },
        { value: "configure", label: "配置服务商 / API Key" },
        { value: "clear", label: "清空本地 API 配置" },
      ],
      onSelect: (item) => item.value === "select" ? onSelectModel() : item.value === "configure" ? onConfigure() : onClearConfig(),
      onBack,
    }),
    h(Hint, null, "模型选择、服务商和本地密钥统一在此管理 · Esc 返回"),
  );
}

export function OtherSettingsScreen({ notice, onTerminology, onCheckUpdate, onExit, onBack }) {
  return h(
    Frame,
    { title: "其他设置", subtitle: "术语资源与应用维护" },
    notice ? h(Box, { marginBottom: 1 }, h(Text, { color: notice.kind === "error" ? "red" : notice.kind === "pending" ? "yellow" : "green" }, notice.text)) : null,
    h(Menu, {
      items: [
        { value: "terminology", label: "术语与领域" },
        { value: "update", label: "检查并安装更新" },
        { value: "exit", label: "退出 TRANSilk" },
      ],
      onSelect: (item) => item.value === "terminology" ? onTerminology() : item.value === "update" ? onCheckUpdate() : onExit(),
      onBack,
    }),
    h(Hint, null, "↑↓ 选择 · Enter 确认 · Esc 返回首页"),
  );
}

export function TerminologySettingsScreen({ termbaseCount, onExternalTermbases, onDomainTaxonomy, onBack }) {
  return h(
    Frame,
    { title: "术语与领域", subtitle: "本地资源" },
    h(Menu, {
      items: [
        { value: "external", label: `外部术语库  ·  ${termbaseCount} 个挂载` },
        { value: "domains", label: "领域词表管理" },
      ],
      onSelect: (item) => item.value === "external" ? onExternalTermbases() : onDomainTaxonomy(),
      onBack,
    }),
    h(Hint, null, "项目专用译法在各项目内管理 · Esc 返回其他设置"),
  );
}

export function DomainTaxonomyScreen({ domains, pending, notice, onSelectPending, onAdd, onOpen, onRefresh, onBack }) {
  const items = [
    ...pending.map((entry, index) => ({
      value: `pending:${index}`,
      label: `待处理 · ${entry.suggestion}${entry.title ? ` · ${entry.title}` : ""}`,
    })),
    { value: "add", label: "＋ 手动新增领域" },
    { value: "open-local", label: "打开个人领域词表（可直接编辑）" },
    { value: "open-pending", label: "打开待归类记录（可直接编辑）" },
    { value: "open-seed", label: "打开内置领域词表（随版本更新）" },
    { value: "refresh", label: "刷新词表" },
  ];
  return h(
    Frame,
    { title: "领域词表管理", subtitle: `已收录 ${domains.length} 项 · 待处理 ${pending.length} 项` },
    notice ? h(Box, { marginBottom: 1 }, h(Text, { color: notice.kind === "error" ? "red" : "green" }, notice.text)) : null,
    pending.length === 0 ? h(Box, { marginBottom: 1 }, h(Text, { dimColor: true }, "暂无待归类记录。")) : null,
    h(Menu, {
      items,
      onSelect: (item) => {
        if (item.value.startsWith("pending:")) onSelectPending(Number(item.value.split(":")[1]));
        else if (item.value === "add") onAdd();
        else if (item.value === "refresh") onRefresh();
        else onOpen(item.value);
      },
      onBack,
    }),
    h(Hint, null, "个人词表适合长期自定义；外部编辑后请选择“刷新词表”。"),
  );
}

function DomainAddScreen({ onSubmit, onBack }) {
  return h(
    Frame,
    { title: "手动新增领域", subtitle: "写入个人领域词表" },
    h(TextEntry, { label: "领域名", placeholder: "例如：医学", onSubmit, onBack }),
  );
}

function DomainPendingScreen({ entry, onAccept, onDismiss, onBack }) {
  return h(
    Frame,
    { title: "处理待归类领域", subtitle: entry.suggestion },
    h(Text, null, `建议领域：${entry.suggestion}`),
    h(Text, { dimColor: true }, `来源：${entry.title || "未记录"}${entry.date ? ` · ${entry.date}` : ""}`),
    h(Box, { marginTop: 1 }, h(Menu, {
      items: [
        { value: "accept", label: "修改名称后收录到个人词表" },
        { value: "dismiss", label: "驳回并移出待归类" },
        { value: "back", label: "返回" },
      ],
      onSelect: (item) => item.value === "accept" ? onAccept() : item.value === "dismiss" ? onDismiss() : onBack(),
      onBack,
    })),
  );
}

export function DomainPendingEditScreen({ entry, notice, onSubmit, onBack }) {
  return h(
    Frame,
    { title: "修改后收录", subtitle: "原待归类记录会在成功后移除" },
    notice ? h(Box, { marginBottom: 1 }, h(Text, { color: notice.kind === "error" ? "red" : "green" }, notice.text)) : null,
    h(TextEntry, {
      label: "收录名称",
      initial: entry.suggestion,
      placeholder: "请输入领域名",
      onSubmit,
      onBack,
    }),
  );
}

function ClearConfigConfirm({ onConfirm, onBack }) {
  return h(
    Frame,
    { title: "清空本地 API 配置", subtitle: "仅删除本机密钥文件" },
    h(Text, null, "这会删除 config/secrets.local.json，不会删除项目或翻译文件。"),
    h(Box, { marginTop: 1 }, h(Menu, {
      items: [
        { value: "confirm", label: "确认清空" },
        { value: "cancel", label: "取消" },
      ],
      onSelect: (item) => item.value === "confirm" ? onConfirm() : onBack(),
      onBack,
    })),
    h(Hint, null, "↑↓ 选择 · Enter 确认 · Esc 返回"),
  );
}

function DeleteProjectConfirm({ project, onConfirm, onBack }) {
  return h(
    Frame,
    { title: "删除项目", subtitle: "不可撤销" },
    h(Text, { color: "yellow" }, `确定删除“${project.title}”吗？`),
    h(Text, { dimColor: true }, "项目目录、原材料副本、中间产物和翻译资产都会删除。"),
    h(Box, { marginTop: 1 }, h(Menu, {
      items: [
        { value: "confirm", label: "确认删除" },
        { value: "cancel", label: "取消" },
      ],
      onSelect: (item) => item.value === "confirm" ? onConfirm() : onBack(),
      onBack,
    })),
    h(Hint, null, "↑↓ 选择 · Enter 确认 · Esc 返回"),
  );
}

export function ProjectList({ projects, onOpen, onBack }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const filtered = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase("zh-CN");
    if (!keyword) return projects;
    return projects.filter((project) => project.title.toLocaleLowerCase("zh-CN").includes(keyword));
  }, [projects, query]);
  const items = useMemo(() => [
    ...filtered.map((project) => ({
      value: project.projectDir,
      label: `${project.title}  ·  ${project.currentLabel}`,
      project,
    })),
    { value: "__back__", label: "返回首页" },
  ], [filtered]);
  const maxVisible = 12;
  const start = Math.max(0, Math.min(index - Math.floor(maxVisible / 2), items.length - maxVisible));
  const visibleItems = items.slice(start, start + maxVisible);

  useEffect(() => setIndex(0), [query]);

  useInput((input, key) => {
    if (key.upArrow) return setIndex((value) => (value - 1 + items.length) % items.length);
    if (key.downArrow) return setIndex((value) => (value + 1) % items.length);
    if (key.return) {
      const item = items[index];
      if (item?.value === "__back__") onBack();
      else if (item) onOpen(item.project);
      return;
    }
    if (key.escape) {
      if (query) setQuery("");
      else onBack();
      return;
    }
    if (key.backspace || key.delete) {
      setQuery((current) => Array.from(current).slice(0, -1).join(""));
      return;
    }
    if (key.ctrl && input === "u") {
      setQuery("");
      return;
    }
    if (input && !key.ctrl && !key.meta && !key.tab) setQuery((current) => current + input);
  });

  return h(
    Frame,
    { title: "项目列表", subtitle: `${projects.length} 个项目` },
    h(Box, { marginBottom: 1 },
      h(Text, { bold: true }, "搜索："),
      query ? h(Text, { color: "cyan" }, query) : h(Text, { dimColor: true }, "输入项目名称"),
    ),
    projects.length
      ? query && !filtered.length ? h(Box, { marginBottom: 1 }, h(Text, { dimColor: true }, "没有匹配的项目。")) : null
      : h(Box, { marginBottom: 1 }, h(Text, { dimColor: true }, "还没有项目。")),
    h(Box, { flexDirection: "column" },
      start > 0 ? h(Text, { dimColor: true }, `  ↑ 还有 ${start} 项`) : null,
      ...visibleItems.map((item, visibleIndex) => {
        const itemIndex = start + visibleIndex;
        return h(
          Text,
          { key: item.value, color: itemIndex === index ? "cyan" : undefined, bold: itemIndex === index },
          `${itemIndex === index ? "›" : " "} ${item.label}`,
        );
      }),
      start + visibleItems.length < items.length
        ? h(Text, { dimColor: true }, `  ↓ 还有 ${items.length - start - visibleItems.length} 项`)
        : null,
    ),
    h(Hint, null, "输入即搜索 · Ctrl+U 清空 · Esc 清空或返回"),
  );
}

function StageList({ stages }) {
  return h(
    Box,
    { flexDirection: "column" },
    ...stages.map((stage) => {
      const mark = stage.complete ? "✓" : stage.current ? "●" : "○";
      const color = stage.complete ? "green" : stage.current ? "yellow" : "gray";
      return h(Text, { key: stage.number, color }, `${mark} Stage ${stage.number}  ${stage.name}`);
    }),
  );
}

export function ProjectView({ project, notice, onAction, onBack }) {
  const stage3 = project.stages[2].complete;
  const stage5 = project.stages[4].complete;
  const stage8 = project.stages[7].complete;
  const items = [];

  if (!stage3) {
    items.push({ value: "open-project-overrides", label: "填写项目专用译法（可选）" });
    items.push({ value: "prep", label: "运行 Stages 1–3" });
  }
  if (stage3 && !stage5) {
    items.push({ value: "open-workbook", label: "打开术语审阅表" });
    items.push({ value: "translate", label: "审阅完成，运行 Stage 5" });
  }
  if (stage5 && !stage8) {
    items.push({ value: "open-bilingual", label: "打开双语对照" });
    items.push({ value: "finish", label: "译后编辑完成，运行 Stages 7–8" });
  }
  if (stage8) {
    items.push({ value: "open-target", label: "打开交付译文" });
    items.push({ value: "archive", label: project.archived ? "重新生成翻译资产" : "生成翻译资产" });
  }
  items.push({ value: "open-folder", label: "打开项目文件夹" });
  items.push({ value: "refresh", label: "刷新状态" });
  items.push({ value: "delete", label: "删除项目" });
  items.push({ value: "back", label: "返回项目列表" });

  return h(
    Frame,
    { title: project.title, subtitle: project.currentLabel },
    notice ? h(Box, { marginBottom: 1 }, h(Text, { color: notice.kind === "error" ? "red" : "green" }, notice.text)) : null,
    h(Box, { marginBottom: 1 }, h(Text, { dimColor: true }, `${project.config.sourceColumnLabel} → ${project.config.targetColumnLabel}`)),
    project.evidenceSummary ? h(Box, { flexDirection: "column", marginBottom: 1 },
      h(Text, { dimColor: true }, "术语分流：不译 → 本地 → 联网查证 → 模型知识"),
      h(Text, null, formatEvidenceSummary(project.evidenceSummary)),
      project.evidenceSummary.modelKnowledge > 0
        ? h(Text, { color: "yellow" }, `模型知识入口：联网未检出 ${project.evidenceSummary.webNotFound}｜联网失败 ${project.evidenceSummary.webError}`)
        : null,
    ) : null,
    h(Box, { gap: 4 },
      h(StageList, { stages: project.stages }),
      h(Box, { flexDirection: "column", flexGrow: 1 },
        h(Text, { bold: true }, "下一步"),
        h(Box, { marginTop: 1, flexDirection: "column" },
          h(Menu, {
            items,
            onSelect: (item) => item.value === "back" ? onBack() : onAction(item.value),
            onBack,
          }),
        ),
      ),
    ),
    h(Hint, null, "人工阶段完成后再选择继续；程序不会替你确认术语或译文。"),
  );
}

function CreateWizard({ onComplete, onBack }) {
  const [step, setStep] = useState(0);
  const [values, setValues] = useState({ sourcePath: "", title: "", sourceLanguage: "zh-CN", targetLanguage: "en-US", targetPath: "" });
  const sourceName = values.sourcePath ? path.basename(values.sourcePath, path.extname(values.sourcePath)) : "";
  const fields = [
    { key: "sourcePath", label: "原始材料路径", placeholder: "可把 .txt、.md、.doc、.docx、.xls 或 .xlsx 文件拖进终端" },
    { key: "title", label: "项目名称", initial: values.title || sourceName },
    null,
    null,
    { key: "targetPath", label: "既有译文路径", placeholder: "没有就直接按 Enter", optional: true },
  ];
  const field = fields[step];

  if (step === 2) {
    return h(LanguagePicker, {
      title: "选择源语",
      options: LANGUAGE_OPTIONS,
      onSelect: (sourceLanguage) => { setValues({ ...values, sourceLanguage }); setStep(3); },
      onManual: () => setStep(2.5),
      onBack: () => setStep(1),
    });
  }

  if (step === 2.5) {
    return h(
      Frame,
      { title: "新建项目", subtitle: "源语代码" },
      h(TextEntry, {
        label: "源语言代码",
        placeholder: "例如 ja-JP、fr-FR、de-DE",
        onSubmit: (input) => {
          setValues({ ...values, sourceLanguage: input.trim() });
          setStep(3);
        },
        onBack: () => setStep(2),
      }),
      h(Hint, null, "输入标准语言代码 · Enter 确认"),
    );
  }

  if (step === 3) {
    return h(LanguagePicker, {
      title: "选择目标语",
      options: LANGUAGE_OPTIONS,
      onSelect: (targetLanguage) => { setValues({ ...values, targetLanguage }); setStep(4); },
      onManual: () => setStep(3.5),
      onBack: () => setStep(2),
    });
  }

  if (step === 3.5) {
    return h(
      Frame,
      { title: "新建项目", subtitle: "目标语代码" },
      h(TextEntry, {
        label: "目标语言代码",
        placeholder: "例如 en-US、zh-CN、fr-FR",
        onSubmit: (input) => {
          setValues({ ...values, targetLanguage: input.trim() });
          setStep(4);
        },
        onBack: () => setStep(3),
      }),
      h(Hint, null, "目标语必须明确指定 · Enter 确认"),
    );
  }

  const submit = (input) => {
    const next = { ...values, [field.key]: input || field.initial || "" };
    setValues(next);
    if (step === fields.length - 1) onComplete({ ...next, direction: `${next.sourceLanguage}->${next.targetLanguage}` });
    else setStep(step + 1);
  };

  return h(
    Frame,
    { title: "新建项目", subtitle: `${step === 4 ? 5 : step + 1} / 5` },
    h(TextEntry, {
      key: step,
      label: field.label,
      initial: field.initial || values[field.key] || "",
      placeholder: field.placeholder,
      optional: field.optional,
      onSubmit: submit,
      onBack: () => step === 0 ? onBack() : setStep(step - 1),
    }),
  );
}

function ModelPicker({ title, subtitle, provider, onSelect, onBack, onReconfigure, loadModels }) {
  const isCliAgent = provider.protocol === "cli-agent";
  const [models, setModels] = useState([]);
  const [modelState, setModelState] = useState({ loading: false, error: "", refresh: 0 });
  const [manual, setManual] = useState(false);
  const [pendingModel, setPendingModel] = useState(null);

  useEffect(() => {
    if (isCliAgent) return undefined;
    let active = true;
    setModelState((current) => ({ ...current, loading: true, error: "" }));
    loadModels(provider)
      .then((available) => {
        if (!active) return;
        setModels(available);
        setModelState((current) => ({ ...current, loading: false, error: "" }));
      })
      .catch((error) => {
        if (!active) return;
        setModels([]);
        setModelState((current) => ({ ...current, loading: false, error: error.message }));
      });
    return () => {
      active = false;
    };
  }, [modelState.refresh, provider, loadModels, isCliAgent]);

  if (isCliAgent) {
    const modelDocURL = provider.cli === "claude"
      ? "https://code.claude.com/docs/en/model-config"
      : "https://learn.chatgpt.com/docs/models";
    const modelExample = provider.cli === "claude" ? "claude-fable-5" : "gpt-5.6-sol";
    if (pendingModel === null) {
      return h(
        Frame,
        { title, subtitle: subtitle ? `${subtitle} · 选择模型` : "选择模型" },
        h(TextEntry, {
          label: "模型 ID（可留空使用 CLI 默认模型）",
          initial: provider.model || "",
          onSubmit: (model) => setPendingModel(model || ""),
          onBack,
        }),
        h(Hint, null, `示例：${modelExample}；查看当前可用模型和命名：${modelDocURL}`),
      );
    }
    const effortExample = "high";
    return h(
      Frame,
      { title, subtitle: subtitle ? `${subtitle} · 推理强度` : "推理强度" },
      h(TextEntry, {
        label: "推理强度（可选，留空使用 CLI 默认值）",
        initial: provider.effort || "",
        onSubmit: (effort) => onSelect(pendingModel, effort || ""),
        onBack: () => setPendingModel(null),
      }),
      h(Hint, null, `示例：${effortExample}；查看可选值：${provider.cli === "claude" ? "claude --help" : "codex --help"}`),
      h(Hint, null, "提示：前沿或敏感领域的文本经 AI 翻译时可能被判定为敏感内容而拒答，可换用本地术语库尝试或人工处理。为了您的账号安全，请不要反复尝试。"),
    );
  }

  if (manual) {
    return h(
      Frame,
      { title, subtitle: "手动输入" },
      h(TextEntry, {
        label: "模型 ID",
        initial: provider.model || "",
        onSubmit: (model) => model && onSelect(model),
        onBack: () => setManual(false),
      }),
    );
  }

  const retry = () => setModelState((current) => ({ ...current, refresh: current.refresh + 1 }));
  const items = [
    ...models.map((model) => ({ value: model, label: model === provider.model ? `${model}  ·  当前` : model })),
    { value: "__manual__", label: "手动输入模型 ID" },
    { value: "__refresh__", label: "↻ 刷新可用模型" },
    ...(onReconfigure ? [{ value: "__reconfigure__", label: "重新配置服务商 / API Key" }] : []),
  ];
  return h(
    Frame,
    { title, subtitle },
    h(Text, { bold: true }, "选择模型"),
    modelState.loading
      ? h(Box, { marginTop: 1 }, h(Text, { color: "yellow" }, "● 正在获取当前可用模型……"))
      : h(Box, { marginTop: 1, flexDirection: "column" },
          modelState.error ? h(Text, { color: "red" }, modelState.error) : null,
          h(Menu, {
            items,
            onSelect: (item) => {
              if (item.value === "__manual__") return setManual(true);
              if (item.value === "__refresh__") return retry();
              if (item.value === "__reconfigure__") return onReconfigure();
              onSelect(item.value);
            },
            onBack,
          }),
        ),
    h(Hint, null, "列表来自当前服务商接口；也可以手动输入。"),
    h(Hint, null, "提示：前沿或敏感领域的文本经 AI 翻译时可能被判定为敏感内容而拒答，可换用本地术语库尝试或人工处理。为了您的账号安全，请不要反复尝试。"),
  );
}

export function ModelSwitch({ config, onComplete, onReconfigure, onBack, loadModels = listAvailableModels }) {
  const providerKey = config.provider;
  const provider = config[providerKey];
  return h(ModelPicker, {
    title: "切换模型",
    subtitle: MODEL_PRESETS[providerKey]?.label || providerKey,
    provider,
    onSelect: onComplete,
    onReconfigure,
    onBack,
    loadModels,
  });
}

export function ConfigWizard({ pendingLabel, onComplete, onBack, loadModels = listAvailableModels }) {
  const [step, setStep] = useState(0);
  const [savedConfig] = useState(() => readModelConfig() || {});
  const [values, setValues] = useState({ providerKey: "deepseek", baseURL: "", model: "", apiKey: "", effort: "", providerReady: false });
  const entries = Object.entries(MODEL_PRESETS);

  if (step === 0) {
    return h(
      Frame,
      { title: "模型配置", subtitle: pendingLabel },
      h(Text, { bold: true }, "选择模型服务商"),
      h(Box, { marginTop: 1, flexDirection: "column" },
        h(Menu, {
          items: entries.map(([value, preset]) => ({
            value,
            label: savedConfig[value]?.apiKey ? `${preset.label}  ·  已保存` : preset.label,
          })),
          onSelect: (item) => {
            const preset = MODEL_PRESETS[item.value];
            const existing = savedConfig[item.value];
            const providerReady = preset.protocol === "cli-agent" || Boolean(existing?.baseURL && existing?.apiKey);
            setValues({
              ...values,
              providerKey: item.value,
              baseURL: existing?.baseURL || preset.baseURL || "",
              model: existing?.model || "",
              apiKey: existing?.apiKey || "",
              providerReady,
            });
            setStep(providerReady ? 3 : 1);
          },
          onBack,
        }),
      ),
    );
  }

  const fields = [
    { key: "baseURL", label: "API base URL" },
    { key: "apiKey", label: "API key", secret: true },
  ];
  if (step === 3) {
    const preset = MODEL_PRESETS[values.providerKey];
    return h(ModelPicker, {
      title: "模型配置",
      subtitle: "3 / 3",
      provider: { protocol: preset.protocol, baseURL: values.baseURL, apiKey: values.apiKey, model: values.model, cli: preset.cli, effort: values.effort },
      onSelect: (model, effort) => onComplete({ ...values, model, effort }),
      onBack: () => setStep(values.providerReady ? 0 : 2),
      loadModels,
    });
  }

  const field = fields[step - 1];
  const submit = (input) => {
    const resolved = input || values[field.key];
    if (!resolved) return;
    const next = { ...values, [field.key]: resolved };
    setValues(next);
    setStep(step + 1);
  };

  return h(
    Frame,
    { title: "模型配置", subtitle: `${step} / 3` },
    h(TextEntry, {
      key: step,
      label: field.label,
      initial: values[field.key],
      secret: field.secret,
      onSubmit: submit,
      onBack: () => setStep(step - 1),
    }),
  );
}

function cleanOutput(value) {
  return value
    .replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
}

function openPath(targetPath) {
  if (!targetPath || !fs.existsSync(targetPath)) throw new Error(`文件不存在：${targetPath}`);
  const command = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(command, [targetPath], { detached: true, stdio: "ignore", windowsHide: false });
  child.unref();
}

export function App({ initialScreen, initialModel, autoCheckUpdates = false } = {}) {
  const { exit } = useApp();
  const [screen, setScreen] = useState(() => initialScreen || "home");
  const [projects, setProjects] = useState(() => listProjects());
  const [model, setModel] = useState(() => initialModel || modelConfigSummary());
  const [projectDir, setProjectDir] = useState(null);
  const [notice, setNotice] = useState(null);
  const [updateNotice, setUpdateNotice] = useState(null);
  const [running, setRunning] = useState(null);
  const [pending, setPending] = useState(null);
  const [switchConfig, setSwitchConfig] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [pendingDomainIndex, setPendingDomainIndex] = useState(null);
  const project = useMemo(() => projectDir ? inspectProject(projectDir) : null, [projectDir, projects, running]);

  const refresh = useCallback(() => setProjects(listProjects()), []);

  useEffect(() => {
    if (!autoCheckUpdates) return undefined;
    let active = true;
    autoCheckForUpdates()
      .then((result) => {
        if (active && result.status === "available") setUpdateNotice({ kind: "pending", text: result.message });
      })
      .catch(() => {});
    return () => { active = false; };
  }, [autoCheckUpdates]);

  const runCommand = useCallback((label, args, selectedDir = projectDir, cleanupOnFailure = false, completionScreen = "home") => {
    setNotice(null);
    setRunning({ label, lines: [] });
    const outputLines = [];
    let spawnError = null;
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd: TOOL_ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const append = (chunk) => {
      const lines = cleanOutput(chunk.toString("utf8"));
      outputLines.push(...lines);
      if (lines.length) setRunning((current) => ({ ...current, lines: outputLines.slice(-14) }));
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", (code) => {
      let cleanupError = null;
      if (code !== 0 && cleanupOnFailure && selectedDir) {
        try {
          deleteProject(selectedDir);
          setProjectDir(null);
        } catch (error) {
          cleanupError = error;
        }
      }
      setRunning(null);
      refresh();
      if (selectedDir && code === 0) setProjectDir(selectedDir);
      setScreen(selectedDir && code === 0 ? "project" : completionScreen);
      const detail = spawnError?.message || outputLines.at(-1);
      setNotice(code === 0
        ? { kind: "success", text: `${label}完成。` }
        : { kind: "error", text: `${label}失败${detail ? `：${detail}` : "。"}${cleanupError ? ` 清理失败：${cleanupError.message}` : " 已清理失败项目。"}` });
    });
  }, [projectDir, refresh]);

  const runModelCommand = useCallback((label, args) => {
    if (!hasModelConfig()) {
      setPending({ label, args, projectDir });
      setScreen("config");
      return;
    }
    runCommand(label, args);
  }, [projectDir, runCommand]);

  const createProject = useCallback((values) => {
    try {
      const sourcePath = normalizeInputPath(values.sourcePath);
      const targetPath = normalizeInputPath(values.targetPath);
      if (!fs.existsSync(sourcePath)) throw new Error(`找不到原始材料：${sourcePath}`);
      const ext = path.extname(sourcePath).toLowerCase();
      if (![".txt", ".md", ".doc", ".docx", ".xls", ".xlsx"].includes(ext)) {
        throw new Error("原始材料仅支持 .txt、.md、.doc、.docx、.xls 或 .xlsx。");
      }
      if (targetPath && !fs.existsSync(targetPath)) throw new Error(`找不到既有译文：${targetPath}`);
      if (targetPath && [".xls", ".xlsx"].includes(ext)) throw new Error("表格项目不支持既有译文路径。");
      const title = values.title.trim() || path.basename(sourcePath, ext);
      const newProjectDir = projectDirForTitle(title);
      if (fs.existsSync(newProjectDir)) throw new Error(`项目目录已存在：${newProjectDir}`);
      const args = ["bootstrap", newProjectDir, sourcePath, "SEG", title, new Date().toISOString().slice(0, 10), "--direction", values.direction];
      if (targetPath) args.push("--target", targetPath);
      setProjectDir(newProjectDir);
      runCommand("创建项目", args, newProjectDir, true);
    } catch (error) {
      setNotice({ kind: "error", text: error.message });
      setScreen("home");
    }
  }, [runCommand]);

  const act = useCallback(async (action) => {
    try {
      if (action === "prep") return runModelCommand("Stages 1–3", ["prep", projectDir]);
      if (action === "translate") return runModelCommand("Stage 5", ["translate", projectDir]);
      if (action === "finish") return runCommand("Stages 7–8", ["finish", projectDir]);
      if (action === "archive") return runCommand("翻译资产生成", ["archive", projectDir]);
      if (action === "open-project-overrides") {
        const filePath = await ensureProjectOverridesWorkbook(projectDir);
        openPath(filePath);
      }
      if (action === "open-workbook") openPath(project.workbookPath);
      if (action === "open-bilingual") openPath(project.bilingualPath);
      if (action === "open-target") openPath(project.targetPath);
      if (action === "open-folder") openPath(project.projectDir);
      if (action === "delete") {
        setDeleteTarget(project);
        setScreen("delete-project");
        return;
      }
      if (action === "refresh") refresh();
      setNotice({ kind: "success", text: action === "refresh" ? "状态已刷新。" : "已打开。" });
    } catch (error) {
      setNotice({ kind: "error", text: error.message });
    }
  }, [project, projectDir, refresh, runCommand, runModelCommand]);

  if (running) return h(Running, { task: running });
  if (screen === "create") return h(CreateWizard, { onComplete: createProject, onBack: () => setScreen("home") });
  if (screen === "projects") {
    return h(ProjectList, {
      projects,
      onBack: () => setScreen("home"),
      onOpen: (selected) => {
        setNotice(null);
        setProjectDir(selected.projectDir);
        setScreen("project");
      },
    });
  }
  if (screen === "model-settings") {
    return h(ModelSettingsScreen, {
      model,
      notice,
      onBack: () => { setNotice(null); setScreen("home"); },
      onSelectModel: () => {
        setNotice(null);
        const config = readModelConfig();
        const provider = config?.[config.provider];
        const providerReady = provider?.protocol === "cli-agent" || Boolean(provider?.baseURL && provider?.apiKey);
        if (providerReady) {
          setSwitchConfig(config);
          setScreen("model-switch");
        } else {
          setScreen("config");
        }
      },
      onConfigure: () => { setPending(null); setNotice(null); setScreen("config"); },
      onClearConfig: () => { setPending(null); setNotice(null); setScreen("clear-config"); },
    });
  }
  if (screen === "other-settings") {
    return h(OtherSettingsScreen, {
      notice: notice || updateNotice,
      onBack: () => { setNotice(null); setScreen("home"); },
      onTerminology: () => { setNotice(null); setScreen("terminology-settings"); },
      onCheckUpdate: async () => {
        setNotice({ kind: "pending", text: "正在检查并安装更新…" });
        try {
          const result = await checkForUpdates();
          setNotice({ kind: result.status === "diverged" ? "error" : "success", text: result.message });
        } catch (error) {
          setNotice({ kind: "error", text: `检查更新失败：${error.message}，可手动执行 git pull 重试` });
        }
      },
      onExit: exit,
    });
  }
  if (screen === "terminology-settings") {
    return h(TerminologySettingsScreen, {
      termbaseCount: listMountedTermbases().length,
      onBack: () => setScreen("other-settings"),
      onExternalTermbases: () => { setNotice(null); setScreen("external-termbases"); },
      onDomainTaxonomy: () => { setNotice(null); setScreen("domain-taxonomy"); },
    });
  }
  if (screen === "model-switch" && switchConfig) {
    return h(ModelSwitch, {
      config: switchConfig,
      onBack: () => setScreen("model-settings"),
      onReconfigure: () => setScreen("config"),
      onComplete: (selectedModel, effort) => {
        const providerKey = switchConfig.provider;
        saveModelConfig({
          ...switchConfig,
          [providerKey]: { ...switchConfig[providerKey], model: selectedModel, effort: effort || undefined },
        });
        setModel(modelConfigSummary());
        setSwitchConfig(null);
        setNotice({ kind: "success", text: `已切换到 ${selectedModel}。` });
        setScreen("model-settings");
      },
    });
  }
  if (screen === "clear-config") {
    return h(ClearConfigConfirm, {
      onBack: () => setScreen("model-settings"),
      onConfirm: () => {
        const cleared = clearModelConfig();
        setModel(modelConfigSummary());
        setNotice({ kind: cleared ? "success" : "error", text: cleared ? "本地 API 配置已清空。" : "当前没有本地 API 配置。" });
        setScreen("model-settings");
      },
    });
  }
  if (screen === "delete-project" && deleteTarget) {
    return h(DeleteProjectConfirm, {
      project: deleteTarget,
      onBack: () => { setDeleteTarget(null); setScreen("project"); },
      onConfirm: () => {
        try {
          deleteProject(deleteTarget.projectDir);
          setDeleteTarget(null);
          setProjectDir(null);
          refresh();
          setNotice({ kind: "success", text: `项目“${deleteTarget.title}”已删除。` });
          setScreen("home");
        } catch (error) {
          setNotice({ kind: "error", text: `删除失败：${error.message}` });
          setDeleteTarget(null);
          setScreen("project");
        }
      },
    });
  }
  if (screen === "external-termbases") {
    return h(ExternalTermbasesScreen, {
      mounts: listMountedTermbases(),
      notice,
      onBack: () => setScreen("terminology-settings"),
      onMount: () => { setNotice(null); setScreen("import-termbase"); },
      onUnmount: (id) => {
        try {
          const result = unmountExternalTermbase(id);
          if (!result.removed) throw new Error(`未找到外部术语库挂载：${id}`);
          setNotice({ kind: "success", text: `已移除“${result.removed.name}”的挂载，原文件未删除。` });
        } catch (error) {
          setNotice({ kind: "error", text: error.message });
        }
      },
    });
  }
  if (screen === "import-termbase") {
    return h(ImportTermbasePath, {
      onBack: () => setScreen("external-termbases"),
      onSubmit: (input) => {
        try {
          const inputPath = normalizeInputPath(input);
          if (!inputPath) throw new Error("请输入路径。");
          if (!fs.existsSync(inputPath)) throw new Error(`路径不存在：${inputPath}`);
          runCommand("挂载外部术语库", ["mount-termbase", inputPath], null, false, "external-termbases");
        } catch (error) {
          setNotice({ kind: "error", text: error.message });
          setScreen("external-termbases");
        }
      },
    });
  }
  if (screen === "domain-taxonomy") {
    return h(DomainTaxonomyScreen, {
      domains: listDomainLabels(),
      pending: loadPendingDomains(),
      notice,
      onBack: () => setScreen("terminology-settings"),
      onSelectPending: (index) => { setPendingDomainIndex(index); setNotice(null); setScreen("domain-pending"); },
      onAdd: () => { setNotice(null); setScreen("domain-add"); },
      onRefresh: () => setNotice({ kind: "success", text: "领域词表已重新读取。" }),
      onOpen: (action) => {
        try {
          ensureDomainTaxonomyFiles();
          const filePath = action === "open-local"
            ? domainTaxonomyLocalPath()
            : action === "open-pending" ? pendingDomainsPath() : domainTaxonomyPath();
          openPath(filePath);
          setNotice({ kind: "success", text: `已打开：${filePath}` });
        } catch (error) {
          setNotice({ kind: "error", text: error.message });
        }
      },
    });
  }
  if (screen === "domain-add") {
    return h(DomainAddScreen, {
      onBack: () => setScreen("domain-taxonomy"),
      onSubmit: (input) => {
        try {
          const label = input.trim();
          if (!label) throw new Error("请输入领域名。");
          const total = addDomain(label);
          setNotice({ kind: "success", text: `已加入个人词表：“${label}”（当前共 ${total} 项）。` });
          setScreen("domain-taxonomy");
        } catch (error) {
          setNotice({ kind: "error", text: error.message });
        }
      },
    });
  }
  if (screen === "domain-pending" && pendingDomainIndex !== null) {
    const entry = loadPendingDomains()[pendingDomainIndex];
    if (!entry) {
      return h(Frame, { title: "处理待归类领域", subtitle: "记录已变化" },
        h(Text, { color: "yellow" }, "该待归类记录已不存在，可能已在外部编辑器中删除。"),
        h(Box, { marginTop: 1 }, h(Menu, {
          items: [{ value: "back", label: "返回并刷新词表" }],
          onSelect: () => { setPendingDomainIndex(null); setNotice(null); setScreen("domain-taxonomy"); },
          onBack: () => { setPendingDomainIndex(null); setNotice(null); setScreen("domain-taxonomy"); },
        })),
      );
    }
    const finish = (action) => {
      try {
        if (action === "accept") {
          const result = acceptPendingDomain(pendingDomainIndex);
          setNotice({ kind: "success", text: `已收录“${result.entry.suggestion}”（当前共 ${result.total} 项）。` });
        } else {
          const removed = dismissPendingDomain(pendingDomainIndex);
          setNotice({ kind: "success", text: `已驳回“${removed.suggestion}”。` });
        }
      } catch (error) {
        setNotice({ kind: "error", text: error.message });
      }
      setPendingDomainIndex(null);
      setScreen("domain-taxonomy");
    };
    return h(DomainPendingScreen, {
      entry,
      onAccept: () => { setNotice(null); setScreen("domain-pending-edit"); },
      onDismiss: () => finish("dismiss"),
      onBack: () => { setPendingDomainIndex(null); setScreen("domain-taxonomy"); },
    });
  }
  if (screen === "domain-pending-edit" && pendingDomainIndex !== null) {
    const entry = loadPendingDomains()[pendingDomainIndex];
    if (!entry) {
      return h(Frame, { title: "修改后收录", subtitle: "记录已变化" },
        h(Text, { color: "yellow" }, "该待归类记录已不存在，无法继续收录。"),
        h(Box, { marginTop: 1 }, h(Menu, {
          items: [{ value: "back", label: "返回并刷新词表" }],
          onSelect: () => { setPendingDomainIndex(null); setNotice(null); setScreen("domain-taxonomy"); },
          onBack: () => { setPendingDomainIndex(null); setNotice(null); setScreen("domain-taxonomy"); },
        })),
      );
    }
    return h(DomainPendingEditScreen, {
      entry,
      notice,
      onBack: () => { setNotice(null); setScreen("domain-pending"); },
      onSubmit: (input) => {
        try {
          const label = input.trim();
          if (!label) throw new Error("请输入领域名。");
          const result = acceptPendingDomain(pendingDomainIndex, { label });
          setNotice({ kind: "success", text: `已将“${result.entry.suggestion}”修改为“${result.label}”并收录（当前共 ${result.total} 项）。` });
          setPendingDomainIndex(null);
          setScreen("domain-taxonomy");
        } catch (error) {
          setNotice({ kind: "error", text: `${error.message}；待归类记录未改动。` });
        }
      },
    });
  }
  if (screen === "config") {
    return h(ConfigWizard, {
      pendingLabel: pending?.label,
      onBack: () => setScreen(pending?.projectDir ? "project" : "model-settings"),
      onComplete: (values) => {
        const preset = MODEL_PRESETS[values.providerKey];
        const existing = readModelConfig() || {};
        const providerEntry = preset.protocol === "cli-agent"
          ? { protocol: preset.protocol, cli: preset.cli, model: values.model, effort: values.effort || undefined }
          : { protocol: preset.protocol, baseURL: values.baseURL, model: values.model, apiKey: values.apiKey };
        saveModelConfig({
          ...existing,
          provider: values.providerKey,
          [values.providerKey]: providerEntry,
        });
        setModel(modelConfigSummary());
        const task = pending;
        setPending(null);
        if (task) runCommand(task.label, task.args, task.projectDir);
        else {
          setNotice({ kind: "success", text: "模型配置已保存。" });
          setScreen("model-settings");
        }
      },
    });
  }
  if (screen === "project" && project) {
    return h(ProjectView, {
      project,
      notice,
      onAction: act,
      onBack: () => {
        refresh();
        setNotice(null);
        setScreen("home");
      },
    });
  }
  return h(Home, {
    projectCount: projects.length,
    model,
    notice: notice || updateNotice,
    onCreate: () => {
      setNotice(null);
      setScreen("create");
    },
    onProjects: () => {
      refresh();
      setNotice(null);
      setScreen("projects");
    },
    onModelSettings: () => { setPending(null); setNotice(null); setScreen("model-settings"); },
    onOtherSettings: () => { setNotice(null); setScreen("other-settings"); },
  });
}

export async function launchTui() {
  const instance = render(h(App, { autoCheckUpdates: true }), { alternateScreen: true, incrementalRendering: false });
  await instance.waitUntilExit();
}
