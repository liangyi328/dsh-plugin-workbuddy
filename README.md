# dsh-plugin-workbuddy

DSH (DeepSeek Harness) 的 WorkBuddy 国内版模型接入插件。

注册 `workbuddy` provider：

- 模型目录读自本机 WorkBuddy CLI 的产品配置缓存，含每个模型的倍率（含时段折扣）
- 选中 WorkBuddy 模型时，会话输入框旁显示剩余额度与可调的上下文长度
- **零 API Key**：用官方设备授权登录，浏览器点一次即可，令牌自动续期

## 登录（零 API Key）

```bash
dsh-plugin-workbuddy login    # 打印一个浏览器链接，授权后自动保存凭据
dsh-plugin-workbuddy status   # 查看登录状态与凭据位置
dsh-plugin-workbuddy logout   # 清除本地凭据
dsh-plugin-workbuddy models   # 打印当前解析到的模型列表
```

`login` 走 WorkBuddy 官方设备授权流程（`/v2/plugin/auth/*`），不需要 API Key，也不需要
WorkBuddy 桌面客户端保持运行。凭据默认存在 `~/.dsh/.dsh-workbuddy-connect/auth.json`，
过期前会自动用 refresh token 续期。

令牌按以下顺序解析：

1. **插件自己的登录凭据**（推荐，上面 `login` 写入的）
2. 环境变量 `WORKBUDDY_AUTH_TOKEN`
3. DSH 模型页的凭据输入框（引用名 `WORKBUDDY_AUTH_TOKEN`）
4. CLI 会话自动发现（兜底：读取本机已登录的 CodeBuddy/WorkBuddy CLI 会话）

> 第 4 条仅作兜底。CLI 会话目录里可能混有**其他产品渠道**的令牌，用它请求
> WorkBuddy 网关会被判为「非官方渠道」。如果遇到该错误，跑一次 `login` 即可。

## 模型与倍率刷新

模型列表和倍率会在这些时机重新读取：

- 插件启用（`apply`）时
- 定时刷新（默认 60 秒，`catalogRefreshMs` 可调）
- 请求遇到目录里不存在的模型时
- 手动执行 `dsh-plugin-workbuddy models`

倍率（倍率 = 每次调用消耗的积分倍数）带时段促销，例如夜间折扣。插件在**每次读取
目录时按当前时间重算倍率**，所以跨时段不会显示旧价格；折扣生效时模型名会显示成
`GLM-5.2 ×0.395 (原价 ×0.79)` 这样的形式。

只有模型集真正变化时才通知宿主刷新界面，避免无意义的重载。

## 安装

方式一（推荐）——插件页安装：

1. DSH → 插件 → 安装
2. 粘贴本仓库地址：`https://github.com/liangyi328/dsh-plugin-workbuddy`

方式二——命令行：

```
dsh plugin install github:liangyi328/dsh-plugin-workbuddy
```

无构建脚本，依赖由 pnpm 自动安装；装好后在插件页出现卡片，可随时开关。

## 配置（可选）

在 profile 的 `cordis.patch.yml` 里用 id-targeted 覆盖（`- id: llm-workbuddy / config: {...}`）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `scope` | `cli` | `cli` = 对话模型；`all` = 账户目录全部模型 |
| `multiplierInName` | `true` | 在模型名中标注倍率 |
| `catalogRefreshMs` | `60000` | 目录与倍率的刷新间隔（毫秒） |
| `rateLimitMinGapMs` | `700` | 两次请求的最小间隔，避免网关限流 |
| `rateLimitRetries` | `3` | 429 时的重试次数 |
| `channelRetries` | `2` | 遇到渠道校验失败（11128）时换令牌重试的次数 |
| `contextWindowStorePath` | `''`（~/.workbuddy） | 上下文长度选择的持久化位置；`off` 关闭持久化 |
| `loginAuthPath` | `''`（~/.dsh） | 登录凭据的自定义位置 |
| `debugLogPath` | 未设置 | 诊断日志文件；不设置则静默 |

## 说明

请求体会把 `DeepSeek Harness` 这一产品名替换成中性表述，因为国内网关会以
「非官方渠道」为由拒绝包含该词组的请求。这只影响发给网关的文本，不改变工具名、
参数或模型对指令的理解。

## 兼容性

DSH `>=0.2.0-rc.2`（见 `package.json` 的 `dsh.engines`）。MIT License。
