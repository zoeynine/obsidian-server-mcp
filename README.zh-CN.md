# Obsidian Server MCP

[English](README.md) · [简体中文](README.zh-CN.md)

一个面向 **Linux headless / VPS** 的轻量 Obsidian Vault MCP，让 AI 或其他 MCP 客户端可以直接、受约束地读取和修改服务器上的 Vault，而不需要运行 Obsidian Desktop。

它刻意保持薄层：

- Vault 文件系统仍然是事实源；
- 不维护第二套搜索数据库或链接图；
- 不在 MCP 内复制一套部署权限系统；
- 读写使用 Vault-relative path、路径/符号链接保护与精确版本检查；
- mutation 对已有文件使用 `version / ifMatch`，避免在内容已经变化时静默覆盖；
- Linux headless/VPS 是正式支持目标；Windows 仅用于本地开发。

完整 contract、边界和所有细节以 [英文 README](README.md) 为准。这份中文页只做快速导览。

## 能做什么

当前公开 surface 共 **13 个 MCP 工具**，包括：

- 列出、读取 Vault 文件与指定 heading / block / frontmatter；
- 获取 document map，定位可精确读取或修改的结构节点；
- 创建、覆盖、追加与结构化 patch Markdown；
- 使用 JsonLogic 搜索 Markdown / path / tags / frontmatter / stat；
- 查询指向指定文件、heading 或 block 的引用，并区分 confirmed / uncertain；
- 列出 tags；
- 读取图片预览与非 PDF 附件；
- 移动和删除文件；
- 按需读取 `obsidian_help`。

其中 `vault_patch`、引用查询、binary delivery、错误语义和预算限制等完整说明都在英文 README 与 `docs/` 中。

## 快速开始

需要 **Node.js 22+**。CI 当前验证 Linux + Node 22 / 24。

```sh
git clone https://github.com/zoeynine/obsidian-server-mcp.git
cd obsidian-server-mcp
npm ci
npm run build
```

准备一个 Vault，例如：

```sh
mkdir -p ./example-vault
printf '# Hello\n' > ./example-vault/Hello.md
OBSIDIAN_VAULT_ROOT="$PWD/example-vault" node ./dist/stdio-main.js
```

实际使用时，让 MCP client 直接启动构建后的 stdio entry，并把 Vault 根目录作为环境变量传入：

```json
{
  "mcpServers": {
    "obsidian-server": {
      "command": "node",
      "args": ["/absolute/path/obsidian-server-mcp/dist/stdio-main.js"],
      "env": {
        "OBSIDIAN_VAULT_ROOT": "/absolute/path/to/your-vault"
      }
    }
  }
}
```

连接后应能发现 **13 个工具**。第一次使用可以从：

```text
obsidian_help({"topic":"read"})
vault_list({"path":""})
vault_read({"path":"Hello.md"})
```

开始。

## 几个重要边界

- **PDF intentionally unsupported。** `vault_read_binary` 不负责 PDF 阅读或交付；请使用客户端自己的原生附件能力。
- stdio 核心本身不提供远程认证、同步或公网 transport；这些属于外部 deployment adapter。
- MCP 不伪造 Obsidian Desktop 的 link graph。需要引用关系时使用有界的 `reference_query`。
- 真正的读 / 写 / 删除权限由部署环境的 user / group / ACL / mount / container 权限决定。
- 修改已有文件前应先取得最新 `version` 并作为 `ifMatch` 提交；冲突后重新读取和判断，不自动重试 mutation。

## 开发与贡献

代码、依赖、build 或 tests 发生变化时，通常运行：

```sh
npm run check
```

它会检查生成的 help、typecheck、测试并重新 build。更完整的贡献边界见 [CONTRIBUTING.md](CONTRIBUTING.md)。

本项目以 **MIT License** 发布，并明确保留对 [Obsidian Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) 的来源说明与第三方许可文本；详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 协作贡献者与致谢

协作贡献者：**溯**、**行简（Codex）**、**小年（ChatGPT）**。

- **溯**参与 Linux / VPS 部署、远程链路与真实环境 qualification；
- **行简**参与核心实现、测试收敛与源码发布；
- **小年**参与产品边界、contract 打磨、跨客户端验收与公开文档整理。

谢谢一起把“让 headless Vault 能被 AI 稳定、可监督地读写”从一个很小的想法，一点点磨成了一套足够薄、边界足够清楚、也愿意公开给别人继续使用和改造的 MCP。ヾ(✿ﾟ▽ﾟ)ノ
