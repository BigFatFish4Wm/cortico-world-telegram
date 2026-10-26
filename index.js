/**
 * cortico-world-telegram — a Cortico / Coopanion World that talks to its owner through a
 * Telegram bot, over the official Bot API with long polling (no webhook, no public port).
 *
 * Inbound: every message from an allow-listed chat becomes one `telegram.message` event, so the
 * bot sees it in its normal conversation. Outbound: the `tg_send` tool posts a line back to that
 * chat. The World never messages first: Telegram's API does not allow it, and the pet should not
 * shout into a phone anyway.
 */

import fs from 'node:fs'
import path from 'node:path'

const WORLD_ID = 'telegram'
const DEFAULT_API_BASE = 'https://api.telegram.org'
const MAX_TEXT = 4000
const MAX_MEDIA_BYTES = 10 * 1024 * 1024
const POLL_SECONDS = 25
const RETRY_MS = 3000

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function asText(value) {
  return typeof value === 'string' ? value : ''
}

/** `allow` accepts spaces, commas or semicolons; an empty list means "anyone who finds the bot". */
function parseAllowList(raw) {
  return String(raw ?? '')
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

async function tgCall(token, apiBase, method, payload, signal, timeoutMs = 30000) {
  const deadline = AbortSignal.timeout(timeoutMs)
  const composed = signal ? AbortSignal.any([signal, deadline]) : deadline
  const res = await fetch(`${apiBase}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
    signal: composed,
  })
  let data = null
  try {
    data = await res.json()
  } catch {
    data = null
  }
  if (!data || data.ok !== true) {
    const error = new Error(`${method}: ${data?.description || `HTTP ${res.status}`}`)
    error.status = res.status
    error.errorCode = Number(data?.error_code ?? 0)
    throw error
  }
  return data.result
}

export class TelegramWorld {
  constructor(options = {}) {
    this.id = WORLD_ID
    this.cfg = options.cfg ?? {}
    this.ctx = options.ctx ?? null
    this.host = null
    this.running = false
    this.state = 'offline'
    this.hint = ''
    this.botUsername = ''
    this.lastChatId = null
    this.offset = 0
    this.abort = null
    this.loopPromise = null
    this.received = 0
    this.sent = 0
    this.activeToken = ''
    this.configFile = this.findConfigFile()
    this.configCache = null
    this.configMtime = 0
    this.overlayCache = null
    this.overlayMtime = 0
  }

  /**
   * The settings page writes `config.json`; the World reads its own section back by mtime, so a
   * token edited there takes effect on the next poll without restarting the whole app.
   */
  findConfigFile() {
    const candidates = []
    for (const dir of [this.ctx?.botDir, this.ctx?.dataDir]) {
      if (typeof dir === 'string' && dir) candidates.push(path.join(dir, 'config.json'))
    }
    for (const file of candidates) {
      try {
        if (fs.statSync(file).isFile()) return file
      } catch {
        // not there; try the next one
      }
    }
    return null
  }

  liveConfig() {
    if (!this.configFile) return null
    try {
      const stat = fs.statSync(this.configFile)
      if (stat.mtimeMs !== this.configMtime) {
        this.configMtime = stat.mtimeMs
        const parsed = JSON.parse(fs.readFileSync(this.configFile, 'utf8'))
        const section = parsed?.worlds?.[WORLD_ID]
        this.configCache = section && typeof section === 'object' ? section : null
      }
      return this.configCache
    } catch {
      return null
    }
  }

  setting(key, fallback) {
    const live = this.liveConfig()
    if (live && live[key] !== undefined && live[key] !== null) return live[key]
    return fallback
  }

  get token() {
    return asText(this.setting('token', this.cfg.token)).trim()
  }

  get apiBase() {
    return (asText(this.setting('apiBase', this.cfg.apiBase)).trim() || DEFAULT_API_BASE).replace(/\/+$/, '')
  }

  get allow() {
    const base = parseAllowList(this.setting('allow', this.cfg.allow))
    const overlay = this.overlay()
    if (!overlay) return base
    const ids = new Set(base)
    for (const id of overlay.added) ids.add(id)
    for (const id of overlay.removed) ids.delete(id)
    return [...ids]
  }

  get replyChat() {
    return asText(this.setting('replyChat', this.cfg.replyChat)).trim()
  }

  get enabled() {
    return this.setting('enabled', this.cfg.enabled) !== false
  }

  allows(chatId) {
    const list = this.allow
    return list.length === 0 || list.includes(String(chatId))
  }

  /** Only these chats are the person this pet belongs to; everyone else is a guest. */
  get owners() {
    return parseAllowList(this.setting('owner', this.cfg.owner))
  }

  isOwner(chatId) {
    return this.owners.includes(String(chatId))
  }

  /** What a chat that is not the owner may do: nothing (default), only chat, or be ignored. */
  get guestMode() {
    const raw = String(this.setting('guestMode', this.cfg.guestMode) ?? '').trim()
    if (raw === 'chat' || raw === '朋友可聊天') return 'chat'
    if (raw === 'silent' || raw === '朋友完全忽略') return 'silent'
    return 'owner-only'
  }

  /** Additions and removals from `/allow` and `/deny`, kept beside the World's own data. */
  get overlayFile() {
    const dir = this.ctx?.dataDir
    return typeof dir === 'string' && dir ? path.join(dir, 'telegram-allow.json') : null
  }

  overlay() {
    const file = this.overlayFile
    if (!file) return null
    try {
      const stat = fs.statSync(file)
      if (stat.mtimeMs !== this.overlayMtime) {
        this.overlayMtime = stat.mtimeMs
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
        this.overlayCache = {
          added: Array.isArray(parsed?.added) ? parsed.added.map(String) : [],
          removed: Array.isArray(parsed?.removed) ? parsed.removed.map(String) : [],
        }
      }
    } catch {
      // no file yet: the config list stands on its own
    }
    return this.overlayCache
  }

  saveOverlay(next) {
    const file = this.overlayFile
    if (!file) return false
    try {
      fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
      this.overlayCache = next
      this.overlayMtime = fs.statSync(file).mtimeMs
      return true
    } catch (error) {
      this.host?.log.warn(`telegram: 写白名单失败：${error.message}`)
      return false
    }
  }

  async say(chatId, text) {
    try {
      await tgCall(this.token, this.apiBase, 'sendMessage', {
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      })
      this.sent += 1
      return true
    } catch (error) {
      this.host?.log.warn(`telegram: 回消息失败：${error.message}`)
      return false
    }
  }

  /** `/allow`, `/deny`, `/allowlist`; only chats already allowed may run them. */
  async adminCommand(command, argument, chatId) {
    const overlay = this.overlay() ?? { added: [], removed: [] }

    if (command === '/allowlist' || command === '/white') {
      const list = this.allow
      await this.say(chatId, list.length ? `白名单：${list.join(', ')}` : '白名单是空的：谁找到这个 bot 都能发消息。')
      return true
    }

    const target = argument.trim().split(/\s+/)[0] ?? ''
    if (!target) {
      await this.say(chatId, `用法：${command} <chat id>\n不知道 id 就发 /id。`)
      return true
    }
    if (!/^-?\d+$/.test(target)) {
      await this.say(chatId, 'chat id 是数字（群聊是负数），发 /id 看我给你的那个。')
      return true
    }

    const added = new Set(overlay.added)
    const removed = new Set(overlay.removed)
    if (command === '/allow') {
      removed.delete(target)
      added.add(target)
    } else {
      added.delete(target)
      removed.add(target)
    }

    const saved = this.saveOverlay({ added: [...added], removed: [...removed] })
    await this.say(
      chatId,
      saved
        ? `${command === '/allow' ? '已加入' : '已移出'}白名单：${target}`
        : '白名单没写进去，看一下 Coopanion 日志。',
    )
    return true
  }

  async start(host) {
    this.host = host
    this.running = true
    this.state = 'loading'

    if (this.configFile) host.log.info(`telegram: 配置读取自 ${this.configFile}`)
    else host.log.warn('telegram: 找不到 config.json，只使用启动时的配置')

    if (!this.token) {
      this.state = 'error'
      this.hint = '没有配置 bot token'
      host.log.error('telegram: 没有配置 bot token，这个 World 不会连上')
      return
    }

    try {
      const me = await tgCall(this.token, this.apiBase, 'getMe', {})
      this.botUsername = asText(me?.username)
      this.activeToken = this.token
      this.state = 'online'
      this.hint = this.botUsername ? `@${this.botUsername}` : 'online'
      host.log.info(
        `telegram: 已连上 ${this.hint}；允许的会话=${this.allow.join(',') || '（未限制）'}`,
      )
    } catch (error) {
      this.state = 'error'
      this.hint = error.message
      host.log.error(`telegram: getMe 失败：${error.message}`)
      return
    }

    this.abort = new AbortController()
    this.loopPromise = this.loop(this.abort.signal)
  }

  async stop() {
    this.running = false
    this.abort?.abort()
    this.abort = null
    try {
      await this.loopPromise
    } catch {
      // the abort is the normal way out of a long poll
    }
    this.loopPromise = null
    this.host = null
    this.state = 'offline'
    this.hint = ''
    this.activeToken = ''
  }

  /** Picks up a token edited in the settings page; the next poll uses it. */
  async syncToken() {
    const token = this.token
    if (!token || token === this.activeToken) return token
    try {
      const me = await tgCall(token, this.apiBase, 'getMe', {})
      this.activeToken = token
      this.botUsername = asText(me?.username)
      this.state = 'online'
      this.hint = this.botUsername ? `@${this.botUsername}` : 'online'
      this.host?.log.info(`telegram: 已切换到 ${this.hint}`)
    } catch (error) {
      this.state = 'error'
      this.hint = `换 token 失败：${error.message}`
      this.host?.log.warn(`telegram: 新 token 不可用：${error.message}`)
      return this.activeToken
    }
    return this.activeToken
  }

  async loop(signal) {
    while (this.running && !signal.aborted) {
      try {
        if (!this.enabled) {
          await sleep(5000)
          continue
        }
        const token = await this.syncToken()
        const updates = await tgCall(
          token,
          this.apiBase,
          'getUpdates',
          { timeout: POLL_SECONDS, offset: this.offset, allowed_updates: ['message'] },
          signal,
          (POLL_SECONDS + 15) * 1000,
        )
        if (!Array.isArray(updates)) continue
        for (const update of updates) {
          const id = Number(update?.update_id)
          if (Number.isFinite(id)) this.offset = Math.max(this.offset, id + 1)
          await this.accept(update)
        }
      } catch (error) {
        if (!this.running || signal.aborted) return
        if (error.errorCode === 409 || error.status === 409) {
          this.state = 'error'
          this.hint = '409：另一个进程也在收这个 bot 的更新'
          this.host?.log.warn('telegram: 409 conflict，可能有第二个实例在长轮询同一个 bot')
          await sleep(5000)
          continue
        }
        const detail = error?.cause?.message ? `${error.message}（${error.cause.message}）` : error.message
        this.host?.log.warn(`telegram: 收更新失败：${detail}`)
        await sleep(RETRY_MS)
      }
    }
  }

  async accept(update) {
    const message = update?.message
    const chat = message?.chat
    if (!chat) return
    if (message.from?.is_bot) return
    const text = (asText(message.text) || asText(message.caption)).trim()
    const media = this.mediaOf(message)
    if (!text && !media) return

    const chatId = String(chat.id)
    const words = text.split(/\s+/)
    const command = (words[0] ?? '').toLowerCase().replace(/@[\w_]+$/, '')

    if (command === '/id' || command === '/chatid' || command === '/start') {
      await this.say(chatId, `chat id：${chatId}`)
      return
    }

    if (!this.allows(chatId)) {
      this.host?.log.warn(`telegram: 忽略未授权会话 ${chatId}（把它加进 allow）`)
      return
    }

    const owner = this.isOwner(chatId)

    if (!owner) {
      const mode = this.guestMode
      if (mode === 'silent') {
        this.host?.log.info(`telegram: 朋友 ${chatId} 的消息按设置忽略`)
        return
      }
      if (mode !== 'chat') {
        await this.say(chatId, '这里只听狗修金的话，有事让 ta 来找我。')
        this.host?.log.info(`telegram: 拒绝朋友 ${chatId} 的指令`)
        return
      }
    }

    if (command === '/allow' || command === '/deny' || command === '/allowlist' || command === '/white') {
      if (!owner) {
        await this.say(chatId, '只有主人的账号能改白名单。')
        return
      }
      await this.adminCommand(command, words.slice(1).join(' '), chatId)
      return
    }

    this.received += 1
    this.lastChatId = chatId
    const who =
      [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' ') ||
      message.from?.username ||
      chatId
    const kind =
      chat.type === 'private' ? '私聊' : chat.type === 'group' || chat.type === 'supergroup' ? '群聊' : chat.type
    const role = owner ? '主人' : '朋友，不是主人'

    let blobs
    let label = ''
    if (media) {
      label = media.fallback
      try {
        const bytes = await this.downloadMedia(media.fileId)
        if (bytes) {
          blobs = [{ bytes, mime: media.mime, name: media.name, fallbackText: media.fallback }]
          this.host?.log.info(`telegram: 附件 ${media.fallback} 已下载，${bytes.length} 字节（${media.mime}）`)
        }
      } catch (error) {
        this.host?.log.warn(`telegram: 下载${media.fallback}失败：${error.message}`)
      }
    }
    const body = [label, text].filter(Boolean).join(' ')

    this.host?.log.info(
      `telegram: 收到 ${kind} ${who}（${chatId}，${role}）：${(text || label).slice(0, 40)}`,
    )

    await this.host?.pushEvent(
      {
        type: `${WORLD_ID}.message`,
        source: WORLD_ID,
        ts: new Date().toISOString(),
        origin: 'external',
        text: `【Telegram ${kind} ${who}（${role}）】${body}`,
        senderKey: chatId,
        meta: {
          chatId,
          messageId: message.message_id,
          fromId: message.from?.id ?? null,
          fromName: who,
          role: owner ? 'owner' : 'guest',
          hasMedia: Boolean(media),
        },
        blobs,
      },
      { trigger: 'flush' },
    )
  }

  /** The one image-like attachment a Telegram message carries, if any. */
  mediaOf(message) {
    const photo = Array.isArray(message.photo) ? message.photo.at(-1) : null
    if (photo?.file_id) {
      return { fileId: photo.file_id, mime: 'image/jpeg', name: 'telegram-photo.jpg', fallback: '[图片]' }
    }

    const sticker = message.sticker
    if (sticker) {
      const thumb = sticker.thumbnail
      if (thumb?.file_id) {
        return { fileId: thumb.file_id, mime: 'image/jpeg', name: 'telegram-sticker-thumb.jpg', fallback: '[贴纸]' }
      }
      if (sticker.file_id && !sticker.is_animated && !sticker.is_video) {
        return { fileId: sticker.file_id, mime: 'image/webp', name: 'telegram-sticker.webp', fallback: '[贴纸]' }
      }
      return sticker.file_id
        ? { fileId: sticker.file_id, mime: 'application/octet-stream', name: 'telegram-sticker', fallback: '[贴纸]' }
        : null
    }

    const doc = message.document
    if (doc?.file_id && asText(doc.mime_type).startsWith('image/')) {
      return { fileId: doc.file_id, mime: doc.mime_type, name: doc.file_name || 'telegram-image', fallback: '[图片]' }
    }

    const animation = message.animation
    if (animation?.thumbnail?.file_id) {
      return { fileId: animation.thumbnail.file_id, mime: 'image/jpeg', name: 'telegram-animation-thumb.jpg', fallback: '[动图]' }
    }

    return null
  }

  /** Bot API caps downloads at 20 MB; anything past our own cap is skipped rather than trimmed. */
  async downloadMedia(fileId) {
    const file = await tgCall(this.token, this.apiBase, 'getFile', { file_id: fileId }, undefined, 20000)
    const filePath = asText(file?.file_path)
    if (!filePath) return null
    const size = Number(file?.file_size ?? 0)
    if (size > MAX_MEDIA_BYTES) {
      this.host?.log.warn(`telegram: 附件 ${size} 字节，超过上限 ${MAX_MEDIA_BYTES}，跳过`)
      return null
    }
    const res = await fetch(`${this.apiBase}/file/bot${this.token}/${filePath}`, {
      signal: AbortSignal.timeout(30000),
    })
    if (!res.ok) throw new Error(`下载附件失败：HTTP ${res.status}`)
    const bytes = Buffer.from(await res.arrayBuffer())
    if (bytes.length > MAX_MEDIA_BYTES) return null
    return bytes
  }

  tools() {
    return [
      {
        name: 'tg_send',
        description: [
          'Send one line to the person on Telegram, through the bot this pet is connected to.',
          'Use it only when you have something to say back; the message appears in their phone.',
          'With no chatId it answers the chat that last wrote to you.',
          'Keep it short: one or two sentences, the way a bubble reads.',
        ].join(' '),
        tags: ['speak'],
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', maxLength: MAX_TEXT, description: 'What to send.' },
            chatId: { type: 'string', description: 'Optional. The chat to send to; defaults to the last one that wrote.' },
          },
          required: ['text'],
        },
        handler: async (args) => {
          const text = asText(args?.text).trim()
          if (!text) return '没有内容可发。'
          if (!this.token) return 'Telegram 还没配置 bot token。'
          const chatId =
            asText(args?.chatId).trim() || this.lastChatId || this.replyChat
          if (!chatId) return '不知道发给谁：还没有人给这个 bot 发过消息。'
          if (!this.allows(String(chatId))) return `会话 ${chatId} 不在 allow 名单里，拒绝发送。`
          try {
            await tgCall(this.token, this.apiBase, 'sendMessage', {
              chat_id: chatId,
              text,
              disable_web_page_preview: true,
            })
            this.sent += 1
            return `已发到 Telegram（${chatId}）。`
          } catch (error) {
            return `发送失败：${error.message}`
          }
        },
      },
    ]
  }

  envPromptVars() {
    const state =
      this.state === 'online'
        ? `在线（${this.hint}）`
        : this.state === 'error'
          ? `出错：${this.hint}`
          : '未连接'
    return { 'telegram.status': state }
  }

  webUi() {
    const at = (key) => `worlds.${WORLD_ID}.${key}`
    return {
      label: 'Telegram',
      lamps: [
        {
          label: 'Telegram',
          state: this.state === 'online' ? 'online' : this.state === 'error' ? 'error' : 'offline',
          hint: this.hint || undefined,
        },
      ],
      badges: [
        { label: 'Bot', value: this.botUsername ? `@${this.botUsername}` : '未连接', tone: 'plain' },
        { label: '收到', value: this.received, tone: 'plain' },
        { label: '发出', value: this.sent, tone: 'plain' },
      ],
      config: [
        {
          id: `world:${WORLD_ID}.main`,
          owner: `world:${WORLD_ID}`,
          schema: {
            type: 'object',
            title: 'Telegram 机器人',
            description:
              '用哪个 bot、谁能通过它找桌宠。换 bot 只要把 Bot Token 换成 BotFather 新给的那串：保存后下一次轮询自动换过去，不用重启。',
            properties: {
              [at('enabled')]: {
                type: 'boolean',
                title: '启用',
                description: '关掉后不再收 Telegram 消息（发消息也不受影响）。',
                'x-hot': true,
              },
              [at('token')]: {
                type: 'string',
                title: 'Bot Token',
                description: 'BotFather 给的 token，形如 123456:ABC…。保存后自动换 bot；新 token 不可用会保留旧连接并记一条 warn。',
                'x-hot': true,
              },
              [at('owner')]: {
                type: 'string',
                title: '主人会话',
                description:
                  '只有这些 chat id 算狗修金本人；其它加进来的会话一律标成朋友，不能改白名单。多个用空格或换行分隔。',
                'x-hot': true,
              },
              [at('guestMode')]: {
                type: 'string',
                title: '朋友能做什么',
                description:
                  '只听主人：朋友发消息只收到一句拒绝，不转给宠物；朋友可聊天：照常进对话但标明不是主人；朋友完全忽略：不回复也不再理会。',
                enum: ['只听主人', '朋友可聊天', '朋友完全忽略'],
                'x-hot': true,
              },
              [at('allow')]: {
                type: 'string',
                title: '白名单会话',
                description: '允许说话的 chat id，空格或换行分隔（群聊是负数）。留空表示不限制，谁找到这个 bot 都能发消息。',
                'x-hot': true,
              },
              [at('replyChat')]: {
                type: 'string',
                title: '默认回话会话',
                description: '还没收到过消息时，tg_send 默认发到这个 chat id。',
                'x-hot': true,
              },
            },
          },
        },
      ],
    }
  }
}

const DESCRIBE = {
  tools: [
    {
      name: 'tg_send',
      description:
        'Send one line to the person on Telegram, through the bot this pet is connected to. With no chatId it answers the chat that last wrote to you.',
      tags: ['speak'],
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', maxLength: MAX_TEXT, description: 'What to send.' },
          chatId: { type: 'string', description: 'Optional. The chat to send to; defaults to the last one that wrote.' },
        },
        required: ['text'],
      },
      summary: {
        zh: '通过 Telegram bot 给人发一句话。',
        en: 'Send one line to the person on Telegram.',
      },
    },
  ],
  events: [
    {
      type: 'telegram.message',
      description: {
        zh: '人在 Telegram 上发来的一条消息（只来自 allow 名单里的会话）。',
        en: 'One message the person sent on Telegram, from an allow-listed chat only.',
      },
      trigger: 'flush',
    },
  ],
}

export const definition = {
  id: WORLD_ID,
  label: 'Telegram',
  defaults: () => ({
    enabled: true,
    token: '',
    owner: '',
    guestMode: '只听主人',
    allow: '',
    replyChat: '',
    apiBase: DEFAULT_API_BASE,
  }),
  describe: DESCRIBE,
  create: (ctx) => new TelegramWorld({ cfg: ctx?.cfg, ctx }),
}

export default definition
