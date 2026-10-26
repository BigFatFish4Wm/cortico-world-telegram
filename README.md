# cortico-world-telegram

让 [Coopanion](https://github.com/Pal-AI-Lab/Cortico) 桌宠通过 **Telegram 官方 Bot API** 和你说话。
不开放端口、不配置 webhook、不需要公网 IP：扩展自己长轮询 `getUpdates`。

- **你在手机上发消息** → 变成宠物的一条事件
- **宠物回复** → 通过 `tg_send` 发回你的 Telegram
- **引用回复看得见**：你回复某条消息时，事件里会带上「回复 谁(id:…)：原话开头」，`meta.replyTo` 里也有原文
- **群聊带发送者 id**：每条消息都写成 `名字(id:123456789)`，名字会重、会改，id 才是身份；`meta.fromId` 同源`n- **群聊里也认主人**：按发送者 id 判断，主人在群里说话同样标成「主人」，朋友还是「朋友」
- **也能发图**：`tg_send` 带 `photo` 参数就能发本机图片；给一个目录就发里面最新那张（只允许配置过的目录）
- **图片和贴纸也能看**：照片、贴纸、图片文件会下载成附件交给宠物（动图取缩略图，单个上限 10 MB）
- **主人 / 朋友分得清**：只有你填的 chat id 算「狗修金」，别人的消息不会被当成你
- **白名单**：不在名单里的会话根本进不来
- **会话名可用来发送**：从收到的消息里记住群名，`chat: "小窝"` 就能发到那个群
- **换 bot 不用重启**：改 token，下一次轮询自动切过去

> 还没发布到 npm，所以 Coopanion 的扩展市场里搜不到。用下面的脚本或命令安装。

## 它长什么样

在 Coopanion 的设置里是一个「Telegram 机器人」配置块：

| 字段 | 作用 |
| --- | --- |
| 启用 | 暂停收 Telegram 消息（不影响发） |
| Bot Token | BotFather 给的 token，保存后自动换 bot |
| 主人会话 | 只有这里的 chat id 算你本人 |
| 朋友能做什么 | 只听主人 / 朋友可聊天 / 朋友完全忽略 |
| 白名单会话 | 允许说话的 chat id，群聊是负数 |
| 默认回话会话 | 还没人发过消息时，`tg_send` 默认发到哪 |
| 允许发图的目录 | `tg_send` 只从这里发图；分号或换行分隔，留空 = 不许发图 |
| 群里只在被提及时收 | 开启后群里只有 @bot / 回复 bot / 命中关键词才进对话（默认关） |
| 关键词提及 | 正文里出现这些词也算 @bot，逗号或空格分隔 |
| 连续放行条数 | 一次提及后同一人免提及的条数，默认 3 |
| 连续放行时间窗（秒） | 超过多久没说话就失效，默认 120 |

状态灯和 badge 会显示当前连的 `@bot`、收到和发出的条数。

## 群里只在被提及时收

打开后，群聊里只有这几种消息会进对话：

1. **@ 这个 bot**（`@username` 或点选提及）、**回复 bot 的消息**，或**正文里出现关键词**
2. 被提及之后，**同一个人**接下来的连续消息（有额度、有时间窗）

关键词在设置里的「关键词提及」填，逗号或空格分隔，比如 `大肥鱼, 肥鱼`。

额度规则：

- 一次提及给 3 条额度（可配置）
- 每收到这个人的一条消息扣 1 条，**不管模型回不回**
- 如果模型在这期间回复了，额外补 `n - used` 条（`n` 是当前额度，`used` 是已经用掉的），**至少补 1 条**；并把 `n` 更新成这次补的数目——额度逐次递减，但不会归零

例子：提及 → 模型回复（额度 3）→ 对方发 1 条（不回复，剩 2）→ 再发 1 条（回复了，补 3-2=1，剩 2，n 变 1）→ 再发 1 条（不回复，剩 1）→ 再发 1 条（回复了，按公式补 0，但保底补 1，剩 1）→ 之后每次回复都保底续 1 条，不会断。

时间窗默认 120 秒：超过这么久没说话，连续性作废。私聊不受这套规则影响，永远收。

## 发图

对宠物说一句，例如：

> 把 `D:\图片\屏幕截图` 里最新那张发到群「小窝」，配一句「今天的」

它会调用：

```json
{ "name": "tg_send", "arguments": { "photo": "D:\\图片\\屏幕截图", "chat": "小窝", "text": "今天的" } }
```

规则：

- `photo` 可以是**文件**（jpg / png / webp / gif / bmp），也可以是**目录**——目录时自动取最新的一张
- 路径必须落在「允许发图的目录」里，否则拒绝（防止模型把任意本地文件发出去）
- ≤ 10 MB 用 `sendPhoto`，更大用 `sendDocument`，上限 50 MB
- `text` 会作为图片说明；`chat` 可以是 chat id、`last`，或群名的一部分

## 安装

前置：Coopanion（Cortico 6.x）、Node ≥ 22、pnpm。

### 1. 建 bot

在 Telegram 里找 [@BotFather](https://t.me/BotFather)：

```
/newbot
```

按提示起名字、起一个以 `bot` 结尾的用户名，拿到一串 `123456:ABC...` 的 token。

### 2. 装进 Coopanion

**方法 A：一键脚本（Windows，推荐）**

1. 点 GitHub 的 **Code → Download ZIP**，解压到一个以后不会移动的目录
2. 双击里面的 **`install.bat`**（没有 pnpm 的话先 `npm install -g pnpm`）
3. 脚本会自己找到 Coopanion 的数据目录、沿用它的 pnpm store，把本扩展链过去

**方法 B：手动命令**

```powershell
# <data> 是 Coopanion 的数据目录：%LOCALAPPDATA%\Coopanion\data-location.json 里的 "data"
# （每个人的安装位置不同，不要照抄；install.bat 会自动读这个文件）
cd "<data>\extensions"
pnpm add link:"<本仓库的绝对路径>"
```

如果 pnpm 报 `ERR_PNPM_UNEXPECTED_STORE`，说明它想用的包仓库和 Coopanion 用的不是同一个。看一眼
`<data>\extensions\node_modules\.modules.yaml` 里的 `storeDir`，再加到命令后面：

```powershell
pnpm add link:"<本仓库的绝对路径>" --store-dir "<storeDir>"
```

（`install.bat` 会自动读这个 `storeDir`，所以推荐用它。）

> 想改成拷贝安装，把 `link:` 换成 `file:`。`link:` 的好处是改代码重启即生效，
> 代价是这个目录以后不能移动。

### 3. 重启并配置

完全退出 Coopanion（含托盘）再打开，设置里会出现「Telegram 机器人」：

1. 填 **Bot Token**
2. 在 Telegram 给这个 bot 发一句 `/id`，它会把你的 chat id 回给你
3. 把那个 id 填进 **主人会话**
4. 想加朋友就填进 **白名单会话**，朋友的号发 `/id` 也能自报家门

重启后 bot 会先 `getMe` 连上，日志里能看到 `telegram: 已连上 @你的bot`。

## Telegram 里的命令

| 命令 | 谁能用 | 作用 |
| --- | --- | --- |
| `/id` | 任何人 | 回你当前会话的 chat id |
| `/allow <id>` | 主人 | 加进白名单（写进 `telegram-allow.json`） |
| `/deny <id>` | 主人 | 移出白名单 |
| `/allowlist` | 主人 | 看当前白名单 |

命令由扩展直接处理，不经过宠物，也不会变成对话事件。

## 安全

- **token 等于这个 bot 的钥匙**，只写在本机的 `config.json` 里，别提交、别贴群。
- **白名单留空 = 谁都能发**。装好第一件事就是把主人 id 填上。
- 朋友策略默认「只听主人」：朋友的指令会被回绝，宠物看不到；切到「朋友可聊天」才会进对话，但会标成 guest。
- 只用官方 Bot API 的长轮询：不模拟个人号、不需要手机验证码，风控风险最低。

## 排错

| 现象 | 先看 |
| --- | --- |
| 设置页里没有这一块 | 扩展是否装进了 `<data>\extensions`，然后重启 |
| `install.bat` 一闪而过 | 从 PowerShell 里跑 `install.ps1` 看报错 |
| 日志里 `getMe 失败` | token 是否完整、网络能否到 `api.telegram.org`（国内要代理） |
| `409 conflict` | 同一个 bot 被别处也在长轮询，关掉另一个 |
| 收不到消息 | 白名单是否漏了你的 id；朋友的号是否被「只听主人」挡了 |
| 发出去了但没回复 | 宠物是否被打断 / 模型是否调用了 `tg_send` |
| 图片只显示 `[图片]` | 模型不支持看图、下载失败，或附件超过 10 MB；日志里有 warn |

日志在 `<data>\logs\core.log`，搜 `telegram`。

## 开发

```bash
node test/run.mjs
```

测试会起一个假的 Bot API 服务，覆盖：收消息 → 事件、`tg_send` → sendMessage、`/id`、`/allow` 白名单、朋友被拒。

## 许可

MIT。这是社区扩展，与 Coopanion / Pal AI Lab / Telegram 官方无关。
