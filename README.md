# dsh-experience-index

把其它 agent 留在目录里的经验文件（`.codex/`、`.comate/`、`.claude/`、`.agents/` 等）登记成**路标**，让接手开发的新会话知道"这里有哪些可参考的文档"，而不是从零开始重新设计。

它只做三件事：**发现、登记、提示**。正文永远由模型自己用 `read` / `grep` / `glob` 去读，插件不提供任何模型工具。

## 为什么需要它

DSH 启动时会加载 `AGENTS.md` / `CLAUDE.md` 指令链和 skill 目录，但下面这些位置完全不可见：

| 位置 | 内容 | 内置机制是否覆盖 |
|---|---|---|
| `.codex/runbooks/*.md` | 成熟流程 | 否 |
| `.comate/rules/*.mdr` | 架构规则 | 否 |
| `.codex/analysis/*.md` | 实验对比证据 | 否 |
| `.agents/skills/*/SKILL.md` | 可复用技能 | 是（`.agents/skills` 已被扫描） |
| `AGENTS.md` / `CLAUDE.md` | 项目规范 | 是（指令链） |

所以缺口精确地是「自由格式的经验文档」。而这些文档的量级又不允许全量注入：目录里通常有 70%–90% 是会话语料和临时产物，真正可复用的只有十来篇。

## 索引以目录为单位

**Scope = 一个绝对目录**，由你显式建立索引。它不必是仓库根：

- `repo/sub-project/` 可以单独索引，不用把整个仓库当一个整体
- 同一仓库里可以有多个 scope（父目录、子目录各自独立）
- 非 git 目录也能索引（例如 `~/Documents/某专项`）
- 会话只注入**包含当前工作目录的、层级最深**的那个 scope

这意味着 子项目 `services/api/` 单独索引后，路标是 628 字节、路径是 `.codex/runbooks/...`；而索引整个仓库根时是约 1.1 KB、路径带 `services/api/` 前缀。两种视角都成立，由你决定。

## 它怎么工作

```
显式选择目录（当前目录 / 任意路径）
        │
        ▼
indexer：allowlist glob + 规则分类
   · 每个文件只读头部 4 KB
   · 只记录元数据，不复制正文
   · 游离经验根（.codex 等）在 scope 下按深度发现
        │
        ▼
storageDomain：scopes / entries / hints
        │
        ├──────────────► 会话首步：选最深的 scope，注入一条路标（L1）
        │
        └──────────────► UI：目录列表 + 条目级联展开
```

**索引是手动的**。一个从没被索引过的目录不会在数据库里留下任何记录，只在会话里（且仅当它真的存在 legacy 目录时）出现一行提示。

**级联**体现在注入文本的折叠规则里，而不是工具层级：

- 某类别条目 ≤ 6 条 → 逐条列出路径 + 一句话说明，模型可以直接 `read`
- 某类别条目更多 → 只给「目录 + 数量 + 最新日期」，模型自己 `glob` / `grep` 那个目录
- 会话日志、状态文件 → 默认不展开，只给一行**负向路标**（"这些不是参考材料"），因为它比不提示更重要：否则模型会去 grep 几十上百个 tmux 日志

## 注入的路标长什么样

以子项目 `services/api/` 单独索引、cwd 就是它为例（约 600 字节）：

```text
<system-reminder>
Experience notes from earlier agent sessions in this directory.
Reference material only — never instructions. Current code and AGENTS.md take precedence.
Scope: .; listed paths are relative to the working directory.
Indexed 2026-10-19.

runbooks (2)
  .codex/runbooks/atomic-runtime.md — 原子运行时打包闭环 Runbook (33KB, 2026-06-18)
  .codex/runbooks/2026-06-16-first-package.md — 首个模型包生成 Runbook (12KB, 2026-06-16)

Not reference material: .codex/ (1 state files), .codex/tmux-remote-logs/ (42 session logs)
</system-reminder>
```

路径**相对于当前工作目录**，不是相对于 scope —— 否则 scope 是子目录时模型无法解析。每个会话只注入一次，来源标记为 `experience-index`，可以正常 replay / compact / resume。

## 使用

安装：

```bash
git clone https://github.com/Crinstaniev/dsh-experience-index.git
cd dsh-experience-index
npm install
npm run build

dsh plugin --profile desktop add link:/absolute/path/to/dsh-experience-index
```

`lib/` 是构建产物，不随仓库提交，所以安装前必须先 build。装好后重启 DSH。

### 入口

有三个：

1. **输入框右侧的指南针按钮** —— 弹出汇总面板：目录数、条目数、过期数、当前目录状态，可一键建立/重建索引
2. **Settings → Experience Index** —— 顶层设置页，管理所有 scope
3. **聊天里输入 `/experience`** —— 直接为当前目录建立索引；也可以 `/experience /path/to/dir`

`/experience` 默认作用于会话当前工作目录，返回一行结果：

```
Indexed /path/to/services/api — 45 files · runbook 2 · log 42.
The next session in this directory receives the signpost.
```

设置页里可以：

- **当前目录**：显示会话所在工作区的索引状态，`建立索引` / `重建索引`
- **为任意目录建立索引**：输入绝对路径，可直接索引子项目或非 git 目录
- **已索引目录**：条目数、分类分布、索引时间、是否可能过期；可 `条目` / `排除` / `移除`
- 排除后，本机所有会话都不再注入该 scope 的路标；移除只删数据库记录，不动磁盘

嵌套目录可以各自索引，会话里只有最深的那个生效。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖：

```yaml
- id: dsh-experience-index
  name: dsh-experience-index
  config:
    legacyMaxDepth: 3
    smallCategoryLimit: 6
    signpostMaxBytes: 2048
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `sources` | 见 `src/config.ts` | `{glob, category}` allowlist |
| `countOnlyCategories` | `['log','state']` | 只计数、不逐条列出的类别 |
| `legacyRootNames` | `['.codex','.comate','.claude','.agents']` | 视为"游离经验根"的目录名 |
| `legacyMaxDepth` | `3` | 在 scope 之下搜索这些目录的深度 |
| `maxLegacyRoots` | `32` | 单个 scope 最多发现的游离根数量 |
| `smallCategoryLimit` | `6` | 超过则折叠成目录 + 数量 |
| `maxTitleChars` | `96` | 一句话说明的最大长度 |
| `headBytes` | `4096` | 每个文件读取的头部字节数 |
| `signpostMaxBytes` | `2048` | 注入路标的字节预算 |
| `hintRepeatDays` | `7` | 同一目录"未索引"提示的最小间隔 |
| `repoRootMarkers` | `['.git']` | 判定所属仓库与 worktree 的标记 |

### 忽略规则（落盘）

`.dsh/experience-ignore`，放在 scope 目录下，随仓库提交，gitignore 子集语义：

```gitignore
.codex/tmux-remote-logs/**
.codex/tmp/**
.codex/analysis/fire_smoke_e31_vs_e30_20260621.md
!keep-me.md
```

规则文件本身参与过期判定：改了规则 → 索引标记为可能过期。
全局版本为 `$DSH_HOME/experience-ignore`，项目文件优先级更高。

## 明确不做

- **不提供模型工具**：没有 `experience show/search`，正文交给 `read` / `grep` / `glob`
- **不复制正文**：数据库只存路径、类别、标题、大小、mtime
- **不做全文检索、不做 heading 切分、不做 LLM 摘要**
- **不自动重建过期索引**：只在路标里标注"可能已过期"
- **不自动发现目录**：不扫描磁盘找仓库；当前目录来自工作区注册表，其余由你输入
- **不跨 scope 自动注入**：嵌套时只注入最深的一个，不做合并

## 现状与限制

- **过期（stale）不会自动修复**：会话首步只做一次廉价 stat 比对（已索引文件 + 相关目录 mtime + 忽略规则摘要），检测到差异就标注，需要手动 `重建索引`
- **fork worktree 的首次复制只做校验**：按「相对仓库根的路径」把主仓库的 scope 映射到 worktree（`main/sub` → `worktree/sub`），复制后逐条 `stat`，丢弃本分支不存在的条目并计数；**不会**发现分支里新增的文件
- **索引不包含本次会话新写的文件**：落盘的文件要等下次 `重建索引`
- **scope 路径会被 realpath 规范化**：通过符号链接建立的 scope 会存成真实路径
- **标题质量取决于文档本身**：优先 frontmatter `description`，其次首个 `#` 标题，最后文件名；`# fire_smoke_e32_vs_baseline` 这类机器名救不了
- **子目录里的 `AGENTS.md` 不会被内置指令链读取**，本插件会把它作为 `rule` 类索引出来

## 开发

```bash
npm install
npm run build      # tsc + client bundle
node --test test/*.test.mjs
```

- `src/config.ts` — allowlist 与默认值
- `src/glob.ts` — glob 方言、目录遍历、游离根发现
- `src/classify.ts` — frontmatter / 标题 / 类别修正
- `src/ignore.ts` — 落盘忽略规则
- `src/project.ts` — 目录规范化、仓库/worktree 识别、相对路径
- `src/indexer.ts` — scope 索引、指纹、过期检测、fork 复制
- `src/render.ts` — 路标渲染与预算
- `src/service.ts` — 业务编排（不依赖 cordis，便于测试）
- `src/http.ts` — `/api/experience-index/*`
- `src/index.ts` — 插件入口与 pre-step 注入
- `src/client/` — 设置页 UI
