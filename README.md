# TRANSilk

半自动化多语言翻译工作台，全流程自动化：

1. 文本分析
2. 术语抽取
3. 查证
4. 翻译
5. 交付

在术语确认与译后编辑（PE）两处保留人工判断；除模型调用和联网查证外，全部在本地运行。

## 前置条件

- Node.js 22或更高版本。
- 处理 `.doc`、`.xls`、`.xlsx` 材料需要Windows + Microsoft Word/Excel（通过Office COM
  调用）。`.docx`、`.md`、`.txt` 不受此限制。
- 使用术语查证、机器翻译等Stage前，准备好模型访问方式：至少一个服务商的API key（DeepSeek、
  OpenAI兼容接口或Anthropic），或本机已登录的Claude Code CLI／Codex CLI（用订阅额度，无需
  API key）。

## 快速开始

1. 打开终端，`cd` 到想安装的目录（例如 `cd D:\Tools`），克隆并安装依赖：

   ```powershell
   git clone https://github.com/A1batr055/TRANSilk.git
   cd TRANSilk
   npm install
   ```

   `git clone` 会在当前目录下新建 `TRANSilk` 文件夹，终端所在目录决定了安装位置。

2. 启动：

   ```powershell
   npm start
   ```

   Windows下也可直接双击 `TRANSilk.cmd`。

3. 首次执行需要模型的Stage时，按提示完成配置向导。API key 保存在本地
   `config/secrets.local.json`（已被Git忽略）；如需更换账号，在TUI首页选择
   「清空本地API配置」。

## 使用方法

### 图形界面（TUI）

1. 新建项目，选择原始材料。
2. 选择翻译方向和模型。
3. 打开项目，按顺序运行各个Stage。
4. 在术语审阅表中确认术语（Stage 4）。
5. 在双语对照文本中完成译后编辑（Stage 6）。
6. 生成最终译文；需要积累翻译资产时执行归档。

**语言**

新建项目时分别选择源语和目标语，不使用自动识别。语言代码采用BCP-47风格，内置以下
13种语言的快捷选项：

中文（zh-CN）、英语（en-US）、日语（ja-JP）、韩语（ko-KR）、法语（fr-FR）、德语（de-DE）、
西班牙语（es-ES）、意大利语（it-IT）、葡萄牙语（pt-BR）、俄语（ru-RU）、阿拉伯语（ar-SA）、
泰语（th-TH）、越南语（vi-VN）。

不在此列的语言可手动输入BCP-47格式代码，如 `nl-NL`、`tr-TR`。

**材料格式**

| 格式 | 要求 |
|---|---|
| `.docx`、`.md`、`.txt` | 无 |
| `.doc` | 需要Microsoft Word |
| `.xls`、`.xlsx` | 需要Microsoft Excel，读取序号、原文、译文三列 |

提供已有译文时，程序按段落对齐，已对齐的句段不再调用模型。

**Stage流程**

| Stage | 内容 | 人工操作 |
|---|---|---|
| 1 | 文本分析 | — |
| 2 | 术语抽取 | — |
| 3 | 术语查证 | — |
| 4 | 术语确认 | 打开Excel，确认或修改术语 |
| 5 | 机器翻译 | — |
| 6 | 译后编辑 | 修改双语对照 `bilingual.txt` |
| 7 | 落实核查 | 查看警告，人工裁决（仅警告，不阻断交付） |
| 8 | 交付 | 生成最终译文或回写表格 |

**术语查证**

Stage 3依次执行三层查证：

| 顺序 | 层级 | 规则 |
|---|---|---|
| 1 | 本地术语库 | 精确匹配；命中后终止查证 |
| 2 | 联网查证 | 本地未命中时执行；取得有效证据后终止查证 |
| 3 | 模型知识 | 联网未检出或失败时使用；明确标注进入原因 |

联网查证沿用当前模型配置，无需另配搜索API。程序按以下规则认定联网证据：

| 项目 | 判定规则 |
|---|---|
| 工具调用 | 必须检测到已完成的搜索结果；仅有调用请求或模型自述时无效 |
| 来源 | URL必须来自工具结果或接口引文；CLI缺少来源信息时直接核对公开页面 |
| 摘录 | 工具提供摘要时，所选摘录必须与摘要相符 |
| 多来源 | 不同网站的两项以上有效证据记为“交叉查证”；同站多页记为“单一来源” |
| 异常 | 来源冲突、证据不足、页面无法访问或摘录不符时，记录原因并进入模型知识 |

当前支持Responses Web Search、Anthropic服务器工具、智谱／通义千问／OpenRouter的Chat搜索扩展，
以及Codex CLI和Claude Code CLI。未知调用格式按联网失败处理。

TUI显示各层数量及证据等级；术语审阅表保存所选证据及其来源URL，完整检索记录写入项目证据文件。

本地术语库支持导入TBX文件或目录。Stage 4确认的术语会自动写回，供后续项目复用。

**领域分类**

| 分类 | 作用 |
|---|---|
| 篇章领域 | Stage 1确定，提供全文语境 |
| 术语领域 | Stage 2逐条确定，可与篇章领域不同 |

领域名称取自封闭词表；无法归类的名称进入「待归类」队列。TUI用于审核领域名称，Stage 4审阅表
用于修改术语领域。本地术语库按“原文术语＋领域”区分词义，并允许保留必要的多个译法。

**检查更新**

TUI首页「检查更新」（或命令行`transilk check-update`）拉取上游仓库最新提交，仅当本地可无冲突
快进合并时才自动拉取；本地与远端历史分叉时不会自动合并，会提示手动处理。此操作需要能访问
GitHub，网络受限环境需自行配置代理（如设置`HTTP_PROXY`/`HTTPS_PROXY`环境变量）。

**使用订阅账号（Claude Code CLI／Codex CLI）**

无需模型API key，仅凭Claude或Codex订阅账号即可运行，用量计入订阅账号自身额度，
不产生额外 API 费用。

1. 在本机安装并登录 `claude` 或 `codex` 命令行工具（无需在 TRANSilk 中另行配置）。
2. 首次执行需要模型的 Stage 时，在配置向导的服务商选项中选择「Claude Code CLI」或
   「Codex CLI」。
3. 手动输入模型ID：Claude一侧示例`claude-fable-5`，查看当前可用模型和命名：
   [code.claude.com/docs/en/model-config](https://code.claude.com/docs/en/model-config)；
   Codex一侧示例`gpt-5.6-sol`，查看当前可用模型和命名：
   [learn.chatgpt.com/docs/models](https://learn.chatgpt.com/docs/models)。两者均不提供
   实时查询接口，留空则使用该CLI已配置的默认模型。
4. 可选填写推理强度，示例`high`：Claude一侧对应`--effort`参数，可选值见
   `claude --help`；Codex一侧对应`model_reasoning_effort`配置项，可选值见
   `codex --help`。留空则使用该CLI的默认强度。
5. 后续各Stage按正常流程执行，无需额外配置。

注意：`temperature` 参数在此模式下不生效；前沿或敏感领域文本可能被AI判定为敏感
内容而拒答，此时建议改用本地术语库或人工处理，避免反复重试。

**项目文件夹结构**

```text
<项目目录>/
├── 01_原始材料/                       # 原材料的项目内工作副本
├── 99_项目配置与术语源数据/
│   ├── asset-config.json
│   └── 术语源数据.jsonl                # translate 后生成
├── 02_双语对齐工作簿/                  # archive 后生成
└── 03_翻译记忆与术语交换文件/          # archive 后生成
    ├── *.tmx
    ├── *.tbx
    └── *.jsonl
```

### 命令行

等价于逐步执行TUI背后的同一套Stage，适合批处理场景。

```powershell
# 1. 初始化项目
node src/cli.mjs bootstrap ./my-project ./原文.docx SEG "示例项目" 2026-08-04 --direction zh-CN->en-US

# 2. 生成术语审阅 Excel（Stage 1–3）
node src/cli.mjs prep ./my-project
# → 人工打开 Excel，完成 Stage 4，保存

# 3. 冻结术语表并生成双语对照文本（Stage 4–5）
node src/cli.mjs translate ./my-project
# → 人工修改 bilingual.txt，完成 Stage 6

# 4. 核查并交付（Stage 7–8）
node src/cli.mjs finish ./my-project

# 5. 可选：生成双语对齐工作簿、TMX、TBX、JSONL 资产包
node src/cli.mjs archive ./my-project

# 6. 可选：导入本地术语库（TBX 文件或目录，与项目无关，随时可执行）
node src/cli.mjs import-termbase ./my-termbase.tbx

# 7. 可选：领域词表治理（与项目无关，随时可执行）
node src/cli.mjs list-pending-domains          # 查看待归类的领域建议
node src/cli.mjs add-domain "生活方式"          # 把领域名转正进封闭词表
node src/cli.mjs reclassify-domain ./my-project "信息技术"   # 修正已有项目的domain

# 8. 可选：检查并拉取上游更新
node src/cli.mjs check-update
```

`bootstrap` 支持 `--target` 附带已有译文。查看版本：`transilk --version`。

## 局限

- `.doc`、`.xls`、`.xlsx` 依赖Windows Office COM；相应的Word或Excel必须已安装。
- 文档摄入按段落和规则切句，英文缩写、人名缩写等边界可能需要人工检查。
- 使用 `--target` 时，原文和译文的段落数必须一致。
- 当前面向数千字规模的项目，暂不支持超长文本分批处理。
- 未知的搜索调用格式按联网失败处理，再进入模型知识。
- 本地术语库仅支持TBX格式、按术语精确匹配，不支持TMX记忆库或模糊匹配。
- 通过Claude Code CLI／Codex CLI调用时使用订阅账号自身的额度和限速，`temperature` 参数不
  生效，且需要本机已完成对应CLI的登录。
- 暂不支持PDF，也不面向复杂表格排版。

## License

MIT
