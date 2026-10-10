# dsh-plugin-workbuddy

DSH (DeepSeek Harness) 的 WorkBuddy 模型接入插件。

注册 `workbuddy` provider：

- 模型目录读自本机 WorkBuddy CLI 的产品配置缓存（默认 20 个对话模型，含倍率/折扣标注）
- 选中 WorkBuddy 模型时，会话输入框旁显示剩余额度与可调的上下文长度
- 令牌自动从已登录的 CodeBuddy/WorkBuddy CLI 会话读取，通常无需任何配置

## 前提

本机已安装并登录 WorkBuddy CLI（插件读取其本地会话令牌）。

## 登录与凭据

令牌按以下顺序解析（每次请求重新读取，改完即生效）：

1. **DSH 凭据字段**：模型页 WorkBuddy 卡片的凭据输入框（引用名 `WORKBUDDY_AUTH_TOKEN`），
   粘贴 token 保存即存入本机 DSH 凭据服务
2. **环境变量**：同名 `WORKBUDDY_AUTH_TOKEN`
3. **CLI 会话自动发现**：读取本机已登录的 WorkBuddy / CodeBuddy CLI 会话
   - Windows：`%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth`、`%LOCALAPPDATA%\WorkBuddyExtension\Data\Public\auth`
   - 任意系统：`~/.codebuddy/auth`、`~/.workbuddy/auth`
   - 取最新一条未过期会话；可用 Config 的 `authDir` 显式指定目录

装了 CLI 并登录过的用户**无需任何配置**，插件自动发现令牌；没有 CLI 的用户走第 1/2 条。


## 安装

方式一（推荐）——插件页安装：

1. DSH → 插件 → 安装
2. 粘贴本仓库地址，例如：`https://github.com/<your-name>/dsh-plugin-workbuddy`

方式二——命令行：

```
dsh plugin install github:<your-name>/dsh-plugin-workbuddy
```

无构建脚本，依赖由 pnpm 自动安装；装好后在插件页出现卡片，可随时开关。

## 配置（可选）

在 profile 的 `cordis.patch.yml` 里用 id-targeted 覆盖（`- id: llm-workbuddy / config: {...}`）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `scope` | `cli` | `cli` = 20 个对话模型；`all` = 账户目录全部模型 |
| `multiplierInName` | `true` | 在模型名中标注倍率 |
| `contextWindowStorePath` | `''`（~/.workbuddy） | 上下文长度选择的持久化位置；`off` 关闭持久化 |
| `debugLogPath` | 未设置 | 诊断日志文件；不设置则静默 |

## 兼容性

DSH `>=0.2.0-rc.2`（见 `package.json` 的 `dsh.engines`）。MIT License。
