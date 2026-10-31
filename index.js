/**
 * cortico-world-telegram — a Cortico / Coopanion World that talks to its owner through a
 * Telegram bot, over the official Bot API with long polling (no webhook, no public port).
 *
 * Inbound: every message from an allow-listed chat becomes one `telegram.message` event, so the
 * bot sees it in its normal conversation. Outbound: the `tg_send` tool posts a line, one image or
 * one local document back to that chat, and `tg_send_sticker` replays a sticker the bot has seen.
 * The World never messages first: Telegram's API does not allow it, and the pet should not shout
 * into a phone anyway.
 *
 * The bot can sit in many chats at once. Each event names its chat, and a send without an explicit
 * target answers the chat that has been waiting longest, so several groups are answered in turn
 * instead of all replies landing in whichever one spoke last.
 */

import fs from 'node:fs'
import path from 'node:path'

const WORLD_ID = 'telegram'
const DEFAULT_API_BASE = 'https://api.telegram.org'
const MAX_TEXT = 4000
const MAX_MEDIA_BYTES = 10 * 1024 * 1024
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024
const MAX_CAPTION = 1024
const MAX_FILES_PER_SEND = 10
const MAX_STICKER_BYTES = 5 * 1024 * 1024
const DEFAULT_STICKER_MAX = 300
/** The asset extension each sticker kind is stored with. */
const STICKER_EXT_BY_KIND = { static: '.webp', animated: '.tgs', video: '.webm' }
const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp)$/i
const MIME_BY_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
}
/** Enough of a MIME table that Telegram and the recipient's client label common documents right. */
const DOC_MIME_BY_EXT = {
  '.pdf': 'application/pdf',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.html': 'text/html',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.epub': 'application/epub+zip',
  '.rtf': 'application/rtf',
  '.zip': 'application/zip',
  '.7z': 'application/x-7z-compressed',
  '.rar': 'application/vnd.rar',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
}
const POLL_SECONDS = 25
const RETRY_MS = 3000
const DEFAULT_CONTINUITY = 3
const DEFAULT_WINDOW_SEC = 120
/** One reminder per chat per window when the owner writes somewhere not on the allow list. */
const NOT_ALLOWED_NOTICE_MS = 10 * 60_000

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function asText(value) {
  return typeof value === 'string' ? value : ''
}

/** `12 KB`, `1.4 MB`: the size the receipt shows. */
function formatSize(bytes) {
  const size = Number(bytes) || 0
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  return `${Math.max(1, Math.round(size / 1024))} KB`
}

/** The saved asset's extension: `.webp` static, `.tgs` animated, `.webm` video. */
function stickerExt(kind) {
  return STICKER_EXT_BY_KIND[kind] ?? '.webp'
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

/** The tool declarations; `tools()` adds handlers and `describe` publishes these same strings. */
const TG_TOOL_DECLS = {
  tg_unread: {
    name: 'tg_unread',
    tags: ['memory'],
    description: 'Take buffered Telegram group messages in batches. Only the entries actually returned are marked read; anything past `limit` stays buffered for the next call. Pass the returned `nextCursor` as `cursor` to resume pagination, or omit it to read the earliest remaining. conv filters one chat id, limit defaults to 20. The receipt says how many oldest messages were dropped if the buffer overflowed.',
    parameters: {
      type: 'object',
      properties: {
        conv: { type: 'string', maxLength: 64, description: 'Optional chat id to read only that conversation.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'How many to take, default 20.' },
        cursor: { type: 'integer', minimum: 0, description: 'Resume after this cursor (from the previous result\'s nextCursor).' },
      },
    },
    summary: {
      zh: '取走 Telegram 群里攒下的未读消息(只在群消息未读模式开启时有用),分批取、用 nextCursor 翻页。',
      en: 'Take buffered Telegram group messages (only when group-unread mode is on), in batches with nextCursor paging.',
    },
  },
  tg_send: {
    name: 'tg_send',
    tags: ['speak'],
    description: [
      'Send text, one local image, or local documents to a Telegram chat through this bot.',
      'text alone goes as a message; with photo or file it becomes the caption.',
      'photo is an absolute path to an image file, or a directory — then the newest image inside it is sent.',
      'file is any local document (pdf, md, docx, pptx, xlsx, zip, …): one path, a directory (the newest file inside is sent), or several paths separated by newlines, up to 10.',
      'Both must live under the directories allowed in this World settings; anything else is refused.',
      'chatId or chat picks the target: a numeric chat id, "last", or part of a chat title such as 小窝.',
      'With neither, it answers the chat that has been waiting longest, so several groups are answered in turn.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', maxLength: MAX_TEXT, description: 'Text to send, or the caption when photo or file is set.' },
        photo: { type: 'string', maxLength: 512, description: 'Absolute path of an image file or a directory (the newest image inside is used).' },
        file: { type: 'string', maxLength: 2000, description: 'Absolute path of a document, a directory (the newest file inside is used), or several paths separated by newlines.' },
        chatId: { type: 'string', maxLength: 64, description: 'Optional chat id, "last", or part of a chat title.' },
        chat: { type: 'string', maxLength: 64, description: 'Optional chat title such as 小窝.' },
      },
    },
    summary: {
      zh: '通过 Telegram bot 发一句话、一张本机图片，或一份本机文件（pdf / md / word / ppt 等，限允许的目录）。',
      en: 'Send a line, a local image, or local documents on Telegram, from the allowed directories.',
    },
  },
  tg_send_sticker: {
    name: 'tg_send_sticker',
    tags: ['speak'],
    description: [
      'Send a sticker the bot has seen to a Telegram chat.',
      'Every sticker that arrives is saved on this machine; tg_stickers lists them with a #number handle.',
      'sticker takes that handle (#3 or 3), a file id, a set name, or an emoji; omit it to send the newest saved one.',
      'chatId or chat picks the target; with neither it answers the chat that has been waiting longest.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        sticker: { type: 'string', maxLength: 128, description: 'Handle (#3), file id, set name or emoji; blank sends the newest one.' },
        chatId: { type: 'string', maxLength: 64, description: 'Optional chat id, "last", or part of a chat title.' },
        chat: { type: 'string', maxLength: 64, description: 'Optional chat title such as 小窝.' },
      },
    },
    summary: {
      zh: '把收藏的贴纸发到 Telegram（#编号 / 表情 / 套图名，留空发最新那张）。',
      en: 'Send a saved sticker on Telegram (by #handle, emoji or set name; blank sends the newest).',
    },
  },
  tg_stickers: {
    name: 'tg_stickers',
    tags: ['memory'],
    description: 'List the stickers saved from Telegram chats, newest first: handle, emoji, type, set name, how often it was seen and its size. query filters by emoji, set name or file id.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', maxLength: 64, description: 'Optional emoji, set name or file id to filter by.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'How many to list, default 20.' },
      },
    },
    summary: {
      zh: '列出从 Telegram 收下来的贴纸（#编号、表情、类型、套图名、出现次数、大小）。',
      en: 'List the stickers saved from Telegram chats with their handles and metadata.',
    },
  },
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
    this.botId = null
    this.lastChatId = null
    this.offset = 0
    this.abort = null
    this.loopPromise = null
    this.received = 0
    this.sent = 0
    this.activeToken = ''
    /** Per (chat, person) continuity budgets; see `consumeContinuity`. */
    this.continuity = new Map()
    /** chatId → the person whose delivered message waits for the model's answer. */
    this.pendingReply = new Map()
    /** chatId → { at, name } for a delivered message nobody has answered yet, oldest first on read. */
    this.awaiting = new Map()
    /** chatId → when the owner was last told this chat is not on the allow list. */
    this.notAllowedNotified = new Map()
    this.continuityFile = typeof options.ctx?.dataDir === 'string' && options.ctx.dataDir
      ? path.join(options.ctx.dataDir, 'telegram-continuity.json')
      : null
    this.configFile = this.findConfigFile()
    this.configCache = null
    this.configMtime = 0
    this.overlayCache = null
    this.overlayMtime = 0
    this.chats = new Map()
    this.chatsFile = typeof options.ctx?.dataDir === 'string' && options.ctx.dataDir
      ? path.join(options.ctx.dataDir, 'telegram-chats.json')
      : null
    this.chatsLoaded = false
    this.unreadFile = typeof options.ctx?.dataDir === 'string' && options.ctx.dataDir
      ? path.join(options.ctx.dataDir, 'telegram-unread.json')
      : null
    this.unread = []
    this.unreadPushedAt = 0
    this.unreadSeq = 0
    this.unreadDropped = 0
    this.stickerDir = typeof options.ctx?.dataDir === 'string' && options.ctx.dataDir
      ? path.join(options.ctx.dataDir, 'telegram-stickers')
      : null
    this.stickerFile = typeof options.ctx?.dataDir === 'string' && options.ctx.dataDir
      ? path.join(options.ctx.dataDir, 'telegram-stickers.json')
      : null
    /** file_unique_id → the saved sticker; `seq` is its stable handle ("#3" in tool calls). */
    this.stickers = new Map()
    this.stickerSeq = 0
    this.stickersLoaded = false
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

  /** In groups, deliver only a mention/reply and the continuity chain that follows it. */
  get groupMentionOnly() {
    return this.setting('groupMentionOnly', this.cfg.groupMentionOnly) === true
  }

  /** Continuity messages granted by one mention. */
  get continuityCount() {
    const value = Number(this.setting('continuityCount', this.cfg.continuityCount) || DEFAULT_CONTINUITY)
    return Math.max(1, Math.min(20, Math.round(value)))
  }

  get continuityWindowMs() {
    const value = Number(this.setting('continuityWindowSec', this.cfg.continuityWindowSec) || DEFAULT_WINDOW_SEC)
    return Math.max(10, Math.min(3600, Math.round(value))) * 1000
  }

  continuityKey(chatId, fromId) {
    return `${chatId}\u0000${fromId}`
  }

  loadContinuity() {
    if (!this.continuityFile) return
    try {
      const parsed = JSON.parse(fs.readFileSync(this.continuityFile, 'utf8'))
      for (const entry of Array.isArray(parsed?.entries) ? parsed.entries : []) {
        if (entry?.key) this.continuity.set(entry.key, entry)
      }
    } catch {
      // no file yet
    }
  }

  saveContinuity() {
    if (!this.continuityFile) return
    try {
      fs.writeFileSync(
        this.continuityFile,
        `${JSON.stringify({ entries: [...this.continuity.values()] }, null, 2)}\n`,
        'utf8',
      )
    } catch {
      // budgets survive in memory for this run
    }
  }

  /** A mention starts (or restarts) the chain with the configured count. */
  grantContinuity(chatId, fromId) {
    if (fromId === null || fromId === undefined) return
    const now = Date.now()
    this.continuity.set(this.continuityKey(chatId, fromId), {
      key: this.continuityKey(chatId, fromId),
      chatId: String(chatId),
      fromId: String(fromId),
      n: this.continuityCount,
      budget: this.continuityCount,
      used: 0,
      lastAt: now,
    })
    this.saveContinuity()
  }

  /** Takes one message from the chain; false when there is none (no mention, expired, used up). */
  consumeContinuity(chatId, fromId) {
    if (fromId === null || fromId === undefined) return false
    const key = this.continuityKey(chatId, fromId)
    const entry = this.continuity.get(key)
    if (!entry) return false
    const now = Date.now()
    if (now - entry.lastAt > this.continuityWindowMs) {
      this.continuity.delete(key)
      this.saveContinuity()
      return false
    }
    if (entry.budget <= 0) return false
    entry.budget -= 1
    entry.used += 1
    entry.lastAt = now
    this.saveContinuity()
    return true
  }

  /**
   * The model answered a message that came through the chain: it earns `n - used` more messages,
   * and that grant becomes the new `n` (so the allowance decays instead of renewing forever).
   * Answering a chat also takes it off the waiting queue.
   */
  noteOutbound(chatId) {
    const key = String(chatId)
    this.awaiting.delete(key)
    const pending = this.pendingReply.get(key)
    if (!pending) return
    this.pendingReply.delete(key)
    if (Date.now() - pending.at > this.continuityWindowMs) return
    const entry = this.continuity.get(this.continuityKey(key, pending.fromId))
    if (!entry) return
    const extra = Math.max(1, entry.n - entry.used)
    entry.budget += extra
    entry.n = extra
    entry.used = 0
    entry.lastAt = Date.now()
    this.saveContinuity()
  }

  /** Extra words that count as a mention of the bot (a nickname, a pet name, …). */
  get mentionKeywords() {
    return String(this.setting('mentionKeywords', this.cfg.mentionKeywords) ?? '')
      .split(/[,，;；\s]+/)
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
  }

  /** Did this message call the bot by name, by keyword, or answer one of its messages? */
  mentionsBot(message) {
    const reply = message.reply_to_message
    if (reply?.from) {
      if (this.botId !== null && reply.from.id === this.botId) return true
      if (this.botUsername && String(reply.from.username ?? '').toLowerCase() === this.botUsername.toLowerCase()) {
        return true
      }
    }
    const text = asText(message.text) || asText(message.caption)
    const username = this.botUsername.toLowerCase()
    for (const entity of Array.isArray(message.entities) ? message.entities : []) {
      if (entity?.type === 'text_mention' && this.botId !== null && entity.user?.id === this.botId) return true
      if (entity?.type === 'mention' && username) {
        const slice = text.slice(entity.offset ?? 0, (entity.offset ?? 0) + (entity.length ?? 0))
        if (slice.toLowerCase() === `@${username}`) return true
      }
    }
    const lower = text.toLowerCase()
    if (username && lower.includes(`@${username}`)) return true
    return this.mentionKeywords.some((word) => lower.includes(word))
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
      this.noteOutbound(chatId)
      return true
    } catch (error) {
      this.host?.log.warn(`telegram: 回消息失败：${error.message}`)
      return false
    }
  }

  /**
   * `/allow`, `/deny`, `/allowlist`. The owner may run these from any chat, including one that is
   * not allowed yet, so a freshly joined group can be let in with `/allow` typed right there.
   */
  async adminCommand(command, argument, chatId) {
    const overlay = this.overlay() ?? { added: [], removed: [] }

    if (command === '/allowlist' || command === '/white') {
      const list = this.allow
      await this.say(chatId, list.length ? `白名单：${list.join(', ')}` : '白名单是空的：谁找到这个 bot 都能发消息。')
      return true
    }

    // `/allow` with no id means "this chat", which is what the owner types inside a new group.
    const target = argument.trim().split(/\s+/)[0] ?? ''
    const resolved = target || (command === '/allow' ? String(chatId) : '')
    if (!resolved) {
      await this.say(chatId, `用法：${command} <chat id>\n不知道 id 就发 /id。`)
      return true
    }
    if (!/^-?\d+$/.test(resolved)) {
      await this.say(chatId, 'chat id 是数字（群聊是负数），发 /id 看我给你的那个。')
      return true
    }

    const added = new Set(overlay.added)
    const removed = new Set(overlay.removed)
    if (command === '/allow') {
      removed.delete(resolved)
      added.add(resolved)
    } else {
      added.delete(resolved)
      removed.add(resolved)
    }

    const saved = this.saveOverlay({ added: [...added], removed: [...removed] })
    await this.say(
      chatId,
      saved
        ? `${command === '/allow' ? '已加入' : '已移出'}白名单：${resolved}`
        : '白名单没写进去，看一下 Coopanion 日志。',
    )
    return true
  }

  async start(host) {
    this.host = host
    this.running = true
    this.state = 'loading'
    this.loadChats()
    this.loadContinuity()
    this.loadUnread()
    this.loadStickers()

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
      this.botId = typeof me?.id === 'number' ? me.id : null
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
      this.botId = typeof me?.id === 'number' ? me.id : null
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
          {
            timeout: POLL_SECONDS,
            offset: this.offset,
            // my_chat_member reports the bot being added to a group, which is the moment the group
            // id becomes actionable; channel_post covers a chat that posts as a channel, whose
            // updates the plain message filter drops entirely.
            allowed_updates: ['message', 'channel_post', 'my_chat_member'],
          },
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
    if (update?.my_chat_member) {
      await this.acceptMembership(update.my_chat_member)
      return
    }
    // A chat that broadcasts posts as a channel; the bot is a member and the update type differs.
    const message = update?.message ?? update?.channel_post
    const chat = message?.chat
    if (!chat) return
    if (message.from?.is_bot) return
    const text = (asText(message.text) || asText(message.caption)).trim()
    const media = this.mediaOf(message)
    if (!text && !media) return

    const chatId = String(chat.id)
    const title = asText(chat.title) || asText(chat.username) || chatId
    const isGroup = chat.type === 'group' || chat.type === 'supergroup'
    const isChannel = chat.type === 'channel'
    const words = text.split(/\s+/)
    const command = (words[0] ?? '').toLowerCase().replace(/@[\w_]+$/, '')

    if (command === '/id' || command === '/chatid' || command === '/start') {
      await this.say(chatId, `chat id：${chatId}${asText(chat.title) ? `（${chat.title}）` : ''}`)
      return
    }

    // In a group the chat id is the group, so the person speaking can only be recognised by
    // their own user id. The owner is the owner in every chat the bot can see them in.
    const fromId = message.from?.id ?? null
    const owner = this.isOwner(chatId) || (fromId !== null && this.isOwner(String(fromId)))

    // Admin commands run before the allow gate: otherwise the owner could not let a newly joined
    // group in from that group, which is where the group id is easiest to get.
    if (command === '/allow' || command === '/deny' || command === '/allowlist' || command === '/white') {
      if (!owner) {
        if (this.allows(chatId)) await this.say(chatId, '只有主人的账号能改白名单。')
        else this.host?.log.warn(`telegram: 忽略未授权会话 ${chatId} 里的 ${command}`)
        return
      }
      this.rememberChat(chat, message.from, chat.type)
      await this.adminCommand(command, words.slice(1).join(' '), chatId)
      return
    }

    if (!this.allows(chatId)) {
      if (owner) await this.notifyNotAllowed(chat, title)
      else this.host?.log.warn(`telegram: 忽略未授权会话 ${chatId}（把它加进 allow）`)
      return
    }

    this.rememberChat(chat, message.from, chat.type)

    if (!owner && !isChannel) {
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

    this.received += 1
    this.lastChatId = chatId
    const who =
      [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' ') ||
      message.from?.username ||
      title
    // Names repeat and can be edited; the numeric id is the only stable identity in a group.
    const sender = fromId === null ? who : `${who}(id:${fromId})`
    const kind = chat.type === 'private' ? '私聊' : isGroup ? '群聊' : isChannel ? '频道' : chat.type
    const role = owner ? '主人' : isChannel ? '频道' : '朋友，不是主人'

    const mention = this.mentionsBot(message)
    if (mention) this.grantContinuity(chatId, fromId)
    const continuity = !mention && isGroup ? this.consumeContinuity(chatId, fromId) : false
    if (continuity) this.pendingReply.set(chatId, { fromId, at: Date.now() })
    const ownerCommand = owner && String(text).trim().startsWith('/')

    // unreadMode='all'：群里的普通聊天先攒进缓存，只有 @/回复/关键词或主人命令立刻唤醒模型。
    // 被提及时，把同会话最近 5 条缓存一起带进这一轮正文（那 5 条从缓存移除）。
    let mentionContext = ''
    if (this.unreadMode === 'all' && isGroup && !ownerCommand) {
      if (!mention) {
        const stickerLabel = await this.stickerLabelFor(message, chatId, null)
        this.bufferUnread({
          chatId: String(chatId),
          chatTitle: title,
          sender,
          text: [stickerLabel || media?.fallback, text].filter(Boolean).join(' '),
          atMe: mention,
          owner,
        })
        this.host?.log.info(`telegram: 先存未读 ${chatId}/${fromId}（${mention ? '提及' : '普通'}）`)
        return
      }
      mentionContext = this.takeMentionContext(chatId, 5)
        .map((item) => `[${item.ts.slice(11, 16)}] ${item.sender}：${item.text}`)
        .join('\n')
    }

    const immediate = chat.type === 'private' || mention || continuity || ownerCommand
    if (!immediate && isGroup && this.groupMentionOnly) {
      const stickerLabel = await this.stickerLabelFor(message, chatId, null)
      this.bufferUnread({
        chatId: String(chatId),
        chatTitle: title,
        sender,
        text: [stickerLabel || media?.fallback, text].filter(Boolean).join(' '),
        atMe: mention,
        owner,
      })
      this.host?.log.info(`telegram: 先存未读 ${chatId}/${fromId}（${mention ? '提及' : '普通'}）`)
      return
    }

    let blobs
    let label = ''
    let downloaded = null
    if (media) {
      label = media.fallback
      try {
        const bytes = await this.downloadMedia(media.fileId)
        if (bytes) {
          downloaded = bytes
          blobs = [{ bytes, mime: media.mime, name: media.name, fallbackText: media.fallback }]
          this.host?.log.info(`telegram: 附件 ${media.fallback} 已下载，${bytes.length} 字节（${media.mime}）`)
        }
      } catch (error) {
        this.host?.log.warn(`telegram: 下载${media.fallback}失败：${error.message}`)
      }
    }
    // A sticker also goes into the local collection: its own asset is kept so it can be sent back,
    // and the label carries the handle to send it by.
    let sticker = null
    if (message.sticker) {
      sticker = await this.saveSticker(message.sticker, chatId, { fileId: media?.fileId, bytes: downloaded })
      if (sticker) label = this.stickerLabel(sticker)
    }
    let body = [label, text].filter(Boolean).join(' ')
    if (mentionContext) body = `（前文）\n${mentionContext}\n——\n${body}`
    const quoted = this.quoteOf(message.reply_to_message)
    const quote = quoted
      ? `「回复 ${quoted.name}${quoted.fromId === null ? '' : `(id:${quoted.fromId})`}：${quoted.text}」`
      : ''
    // A group or channel is named so replies can be addressed to it; in a private chat the sender
    // is the chat, and a channel post has no person besides the chat itself.
    const where = isGroup || isChannel ? `「${title}」(${chatId})` : ''
    const speaker = isChannel ? '' : `${sender}（${role}）`
    const head = [kind, where, speaker].filter(Boolean).join(' ')

    this.host?.log.info(
      `telegram: 收到 ${kind}${where ? ` ${title}(${chatId})` : ''} ${sender}（${role}）${quoted ? ' [回复]' : ''}：${(text || label).slice(0, 40)}`,
    )

    this.awaiting.set(chatId, {
      at: Date.now(),
      name: isGroup || isChannel ? title : who,
      messageId: message.message_id ?? null,
    })

    await this.host?.pushEvent(
      {
        type: `${WORLD_ID}.message`,
        source: WORLD_ID,
        ts: new Date().toISOString(),
        origin: 'external',
        text: `【Telegram ${head}】${quote}${body}`,
        senderKey: chatId,
        meta: {
          chatId,
          chatTitle: isGroup || isChannel ? title : null,
          messageId: message.message_id,
          fromId,
          fromName: who,
          fromUsername: message.from?.username ?? null,
          role: owner ? 'owner' : 'guest',
          hasMedia: Boolean(media),
          sticker: sticker ? `#${sticker.seq}` : undefined,
          replyTo: quoted ?? undefined,
        },
        blobs,
      },
      { trigger: 'flush' },
    )
  }

  /**
   * The bot was added to, or removed from, a chat. A new group is exactly the case where its
   * messages would otherwise be dropped before anything names the group, so the id is handed over
   * while it is fresh.
   */
  async acceptMembership(member) {
    const chat = member?.chat
    const status = asText(member?.new_chat_member?.status)
    if (!chat) return
    const chatId = String(chat.id)
    const title = asText(chat.title) || asText(chat.username) || chatId
    if (status !== 'member' && status !== 'administrator' && status !== 'creator') {
      this.host?.log.info(`telegram: 已离开 ${title}(${chatId})（${status || '未知状态'}）`)
      return
    }
    this.rememberChat(chat, member.from, chat.type)
    const allowed = this.allows(chatId)
    this.host?.log.info(`telegram: 被加入「${title}」(${chatId})${allowed ? '' : '，但它还不在白名单里'}`)
    if (allowed) return
    await this.host?.pushEvent(
      {
        type: `${WORLD_ID}.joined`,
        source: WORLD_ID,
        ts: new Date().toISOString(),
        origin: 'internal',
        ephemeral: true,
        text: `【Telegram】被拉进了「${title}」(${chatId})，这个会话还不在 allow 名单里，群里的消息现在收不到。主人在那个群里发 /allow 就放行（它认发送者的账号，不认群）。`,
        senderKey: chatId,
        meta: { chatId, chatTitle: title, type: chat.type },
      },
      { trigger: 'flush' },
    )
  }

  /** Told once per window: this chat is real, but nobody allowed it in yet. */
  async notifyNotAllowed(chat, title) {
    const chatId = String(chat.id)
    const last = this.notAllowedNotified.get(chatId) ?? 0
    this.host?.log.warn(`telegram: 忽略未授权会话 ${chatId}（主人的消息；提醒一次）`)
    if (Date.now() - last < NOT_ALLOWED_NOTICE_MS) return
    this.notAllowedNotified.set(chatId, Date.now())
    const where =
      chat.type === 'private' ? '这个私聊' : chat.type === 'channel' ? `这个频道「${title}」` : `这个群「${title}」`
    await this.say(chatId, `${where}（${chatId}）还没进白名单，里面的消息我收不到。在这里发 /allow ${chatId} 就放行。`)
  }

  /** What a `reply_to_message` points at: who wrote it (name and id) and the start of what it said. */
  quoteOf(reply) {
    if (!reply) return null
    const name =
      [reply.from?.first_name, reply.from?.last_name].filter(Boolean).join(' ') ||
      reply.from?.username ||
      '未知'
    const raw =
      asText(reply.text) ||
      asText(reply.caption) ||
      (reply.photo ? '[图片]' : '') ||
      (reply.sticker ? '[贴纸]' : '') ||
      (reply.document ? '[文件]' : '') ||
      (reply.voice ? '[语音]' : '') ||
      (reply.animation ? '[动图]' : '')
    const text = raw.replace(/\s+/g, ' ').trim().slice(0, 120) || '[消息]'
    return { messageId: reply.message_id ?? null, name, fromId: reply.from?.id ?? null, text }
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
  async downloadMedia(fileId, maxBytes = MAX_MEDIA_BYTES) {
    if (!fileId) return null
    const file = await tgCall(this.token, this.apiBase, 'getFile', { file_id: fileId }, undefined, 20000)
    const filePath = asText(file?.file_path)
    if (!filePath) return null
    const size = Number(file?.file_size ?? 0)
    if (size > maxBytes) {
      this.host?.log.warn(`telegram: 附件 ${size} 字节，超过上限 ${maxBytes}，跳过`)
      return null
    }
    const res = await fetch(`${this.apiBase}/file/bot${this.token}/${filePath}`, {
      signal: AbortSignal.timeout(30000),
    })
    if (!res.ok) throw new Error(`下载附件失败：HTTP ${res.status}`)
    const bytes = Buffer.from(await res.arrayBuffer())
    if (bytes.length > maxBytes) return null
    return bytes
  }

  /** Directories a photo may come from; `%VAR%` is expanded, `;` or newline separates entries. */
  get photoDirs() {
    return this.dirsOf('photoDirs')
  }

  /** Directories a document may come from; an empty list reuses the photo directories. */
  get fileDirs() {
    const dirs = this.dirsOf('fileDirs')
    return dirs.length ? dirs : this.photoDirs
  }

  dirsOf(key) {
    const raw = asText(this.setting(key, this.cfg[key]))
    return raw
      .split(/[\r\n;]+/)
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => item.replace(/%([^%]+)%/g, (_, name) => process.env[name] ?? `%${name}%`))
  }

  loadChats() {
    if (this.chatsLoaded || !this.chatsFile) return
    this.chatsLoaded = true
    try {
      const parsed = JSON.parse(fs.readFileSync(this.chatsFile, 'utf8'))
      for (const entry of Array.isArray(parsed?.chats) ? parsed.chats : []) {
        if (entry?.id) this.chats.set(String(entry.id), entry)
      }
    } catch {
      // no file yet
    }
  }

  rememberChat(chat, from, kind) {
    const id = String(chat.id)
    const title =
      asText(chat.title) ||
      asText(chat.username) ||
      [from?.first_name, from?.last_name].filter(Boolean).join(' ') ||
      id
    const before = this.chats.get(id)
    if (before && before.title === title && before.type === (chat.type ?? kind)) return
    this.chats.set(id, { id, title, type: String(chat.type ?? ''), kind })
    this.saveChats()
  }

  saveChats() {
    if (!this.chatsFile) return
    try {
      fs.writeFileSync(this.chatsFile, `${JSON.stringify({ chats: [...this.chats.values()] }, null, 2)}\n`, 'utf8')
    } catch (error) {
      this.host?.log.warn(`telegram: 记不下会话名：${error.message}`)
    }
  }

  /** The chat waiting longest for an answer, so several chats take turns instead of one winning. */
  defaultChat() {
    let oldest = null
    for (const [chatId, info] of this.awaiting) {
      if (!oldest || info.at < oldest.info.at) oldest = { chatId, info }
    }
    return oldest?.chatId ?? this.lastChatId ?? this.replyChat ?? null
  }

  /** A numeric id, `last`, part of a chat title ("小窝"), or nothing for the longest-waiting chat. */
  resolveChat(value) {
    const raw = asText(value).trim()
    if (!raw) return this.defaultChat()
    if (raw === 'last') return this.lastChatId || this.replyChat
    if (/^-?\d+$/.test(raw)) return raw
    const needle = raw.toLowerCase()
    const matches = [...this.chats.values()].filter((c) => String(c.title ?? '').toLowerCase().includes(needle))
    return matches.length === 1 ? matches[0].id : null
  }

  /** Appended to a receipt: which other chats are still waiting, so a batch is not answered into one. */
  waitingHint(current) {
    const rest = [...this.awaiting.entries()]
      .filter(([chatId]) => chatId !== String(current))
      .sort((a, b) => a[1].at - b[1].at)
    if (!rest.length) return ''
    const names = rest.slice(0, 3).map(([chatId, info]) => `${info.name || chatId}(${chatId})`)
    const more = rest.length > names.length ? ` 等 ${rest.length} 个` : ''
    return ` 另有 ${rest.length} 个会话在等回复：${names.join('、')}${more}。`
  }

  /** Addressed chats with their ids: what the model needs to pick a target by hand. */
  chatHint() {
    const names = [...this.chats.values()].map((c) => `${c.title}(${c.id})`)
    return names.length
      ? `先说清楚发给谁：带 chat 或 chatId（见过的会话有：${names.join('、')}）。`
      : '还没有人给这个 bot 发过消息。'
  }

  /**
   * Turns a tool's path argument into bytes. A directory means "the newest file inside it".
   * Everything outside the allowed directories is refused, so a model cannot mail arbitrary files out.
   */
  readSendable(input, dirs, { imagesOnly = false } = {}) {
    const label = imagesOnly ? '发图' : '发文件'
    const expanded = String(input).replace(/%([^%]+)%/g, (_, name) => process.env[name] ?? `%${name}%`)
    let target = path.resolve(expanded)
    let stat
    try {
      stat = fs.statSync(target)
    } catch {
      throw new Error(`找不到 ${input}`)
    }

    if (stat.isDirectory()) {
      const newest = fs
        .readdirSync(target)
        .filter((name) => (imagesOnly ? IMAGE_EXT.test(name) : !name.startsWith('.')))
        .map((name) => path.join(target, name))
        .map((file) => {
          try {
            return { file, stat: fs.statSync(file) }
          } catch {
            return null
          }
        })
        .filter((entry) => entry?.stat.isFile())
        .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)[0]
      if (!newest) throw new Error(imagesOnly ? `目录里没有图片：${input}` : `目录里没有文件：${input}`)
      target = newest.file
      stat = newest.stat
    }

    const ext = path.extname(target).toLowerCase()
    if (imagesOnly && !IMAGE_EXT.test(target)) throw new Error('只支持图片：jpg / png / webp / gif / bmp')
    if (stat.size > MAX_UPLOAD_BYTES) {
      throw new Error(`文件太大（${Math.round(stat.size / 1024 / 1024)} MB，上限 50 MB）`)
    }

    if (!dirs.length) {
      throw new Error(
        imagesOnly
          ? '还没有配置「允许发图的目录」，先到设置里加上它的上级目录。'
          : '还没有配置「允许发文件的目录」（留空时沿用发图目录，两者都空则不许发），先到设置里加上它的上级目录。',
      )
    }
    const inside = dirs.some((dir) => {
      try {
        const realDir = fs.realpathSync(dir).toLowerCase()
        const real = fs.realpathSync(target).toLowerCase()
        return real === realDir || real.startsWith(realDir + path.sep)
      } catch {
        return false
      }
    })
    if (!inside) {
      throw new Error(`这个路径不在允许${label}的目录里：${target}（当前允许：${dirs.join('、')}）`)
    }

    return {
      bytes: fs.readFileSync(target),
      name: path.basename(target),
      mime: MIME_BY_EXT[ext] ?? DOC_MIME_BY_EXT[ext] ?? 'application/octet-stream',
      size: stat.size,
    }
  }

  readPhoto(input) {
    return this.readSendable(input, this.photoDirs, { imagesOnly: true })
  }

  /** Multipart POST; `sendPhoto`, `sendDocument` and sticker uploads share it. */
  async postForm(method, build, timeoutMs = 120000) {
    const form = new FormData()
    build(form)
    const res = await fetch(`${this.apiBase}/bot${this.token}/${method}`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    })
    const data = await res.json().catch(() => null)
    if (!data || data.ok !== true) {
      throw new Error(`${method}: ${data?.description || `HTTP ${res.status}`}`)
    }
    return data.result
  }

  async sendPhoto(chatId, photo, caption) {
    const method = photo.bytes.length > MAX_MEDIA_BYTES ? 'sendDocument' : 'sendPhoto'
    const field = method === 'sendPhoto' ? 'photo' : 'document'
    await this.postForm(method, (form) => {
      form.append('chat_id', chatId)
      if (caption) form.append('caption', caption.slice(0, MAX_CAPTION))
      form.append(field, new Blob([photo.bytes], { type: photo.mime }), photo.name)
    })
    this.sent += 1
    this.noteOutbound(chatId)
    return `已发到 Telegram（${chatId}）：${photo.name}，${formatSize(photo.bytes.length)}${caption ? '，带说明' : ''}。${this.waitingHint(chatId)}`
  }

  async sendDocument(chatId, doc, caption) {
    await this.postForm('sendDocument', (form) => {
      form.append('chat_id', chatId)
      if (caption) form.append('caption', caption.slice(0, MAX_CAPTION))
      form.append('document', new Blob([doc.bytes], { type: doc.mime }), doc.name)
    })
    this.sent += 1
    this.noteOutbound(chatId)
    return `已发到 Telegram（${chatId}）：${doc.name}，${formatSize(doc.bytes.length)}${caption ? '，带说明' : ''}。`
  }

  /** Sends the paths in `file` (newline separated, directory = newest file inside). */
  async sendFiles(chatId, input, caption) {
    const list = String(input)
      .split(/[\r\n]+/)
      .map((item) => item.trim())
      .filter(Boolean)
    if (!list.length) return '没有文件路径。'
    if (list.length > MAX_FILES_PER_SEND) return `一次最多发 ${MAX_FILES_PER_SEND} 个文件，分两次吧。`
    const dirs = this.fileDirs
    const receipts = []
    for (const [index, item] of list.entries()) {
      try {
        const doc = this.readSendable(item, dirs)
        receipts.push(await this.sendDocument(chatId, doc, index === 0 ? caption : ''))
      } catch (error) {
        receipts.push(`${item} 没发出去：${error.message}`)
        break
      }
    }
    return `${receipts.join('\n')}${this.waitingHint(chatId)}`
  }

  // ---- sticker collection: every sticker the bot sees is kept, and can be sent back ----

  get stickerEnabled() {
    return this.setting('stickerEnabled', this.cfg.stickerEnabled) !== false
  }

  get stickerMax() {
    const value = Number(this.setting('stickerMax', this.cfg.stickerMax) || DEFAULT_STICKER_MAX)
    return Math.max(10, Math.min(2000, Math.round(value)))
  }

  loadStickers() {
    if (this.stickersLoaded || !this.stickerFile) return
    this.stickersLoaded = true
    try {
      const parsed = JSON.parse(fs.readFileSync(this.stickerFile, 'utf8'))
      for (const entry of Array.isArray(parsed?.stickers) ? parsed.stickers : []) {
        if (!entry?.uniqueId) continue
        this.stickers.set(String(entry.uniqueId), entry)
        this.stickerSeq = Math.max(this.stickerSeq, Number(entry.seq) || 0)
      }
    } catch {
      // no file yet
    }
  }

  saveStickers() {
    if (!this.stickerFile) return
    try {
      fs.writeFileSync(
        this.stickerFile,
        `${JSON.stringify({ stickers: [...this.stickers.values()].sort((a, b) => a.seq - b.seq) }, null, 2)}\n`,
        'utf8',
      )
    } catch (error) {
      this.host?.log.warn(`telegram: 贴纸索引写不进去：${error.message}`)
    }
  }

  stickerLabel(entry) {
    return `[贴纸${entry.emoji ? ` ${entry.emoji}` : ''} #${entry.seq}]`
  }

  /** The label for a message's sticker, saving it on the way; empty for anything else. */
  async stickerLabelFor(message, chatId, media) {
    if (!message?.sticker) return ''
    const saved = await this.saveSticker(message.sticker, chatId, media)
    return saved ? this.stickerLabel(saved) : ''
  }

  /**
   * Keeps the sticker the bot just received. The index entry is written before the asset is
   * downloaded, so the event can name the handle; a failed download leaves the file_id usable.
   */
  async saveSticker(sticker, chatId, media) {
    if (!this.stickerEnabled) return null
    const uniqueId = asText(sticker.file_unique_id) || asText(sticker.file_id)
    if (!uniqueId) return null
    const kind = sticker.is_animated ? 'animated' : sticker.is_video ? 'video' : 'static'
    const emoji = asText(sticker.emoji)
    const setId = asText(sticker.set_name)
    const fileId = asText(sticker.file_id)
    const now = Date.now()

    const existing = this.stickers.get(uniqueId)
    if (existing) {
      existing.count = Number(existing.count || 0) + 1
      existing.lastSeen = now
      if (fileId) existing.fileId = fileId
      if (emoji) existing.emoji = emoji
      if (setId) existing.setId = setId
      const source = String(chatId)
      if (!Array.isArray(existing.sources)) existing.sources = []
      if (!existing.sources.includes(source)) existing.sources.push(source)
      this.saveStickers()
      return existing
    }

    if (this.stickers.size >= this.stickerMax) {
      const oldest = [...this.stickers.values()].sort((a, b) => (a.lastSeen || 0) - (b.lastSeen || 0))[0]
      if (oldest) {
        this.stickers.delete(oldest.uniqueId)
        this.dropStickerFiles(oldest)
      }
    }

    this.stickerSeq += 1
    const entry = {
      seq: this.stickerSeq,
      uniqueId,
      fileId,
      kind,
      emoji,
      setId,
      file: null,
      thumb: null,
      bytes: 0,
      firstSeen: now,
      lastSeen: now,
      count: 1,
      sources: [String(chatId)],
    }
    this.stickers.set(uniqueId, entry)
    this.saveStickers()
    try {
      await this.downloadStickerAssets(entry, sticker, media)
    } catch (error) {
      this.host?.log.warn(`telegram: 贴纸 #${entry.seq} 存不下来：${error.message}`)
    }
    this.saveStickers()
    this.host?.log.info(`telegram: 贴纸已收藏 #${entry.seq}${emoji ? ` ${emoji}` : ''}${setId ? `（${setId}）` : ''}`)
    return entry
  }

  async downloadStickerAssets(entry, sticker, media) {
    if (!this.stickerDir) return
    fs.mkdirSync(this.stickerDir, { recursive: true })
    const originalId = asText(sticker.file_id)
    const thumbId = asText(sticker.thumbnail?.file_id)

    try {
      const bytes = media?.bytes && media.fileId === originalId
        ? media.bytes
        : await this.downloadMedia(originalId, MAX_STICKER_BYTES)
      if (bytes) {
        const name = `sticker-${entry.seq}${stickerExt(entry.kind)}`
        fs.writeFileSync(path.join(this.stickerDir, name), bytes)
        entry.file = name
        entry.bytes = bytes.length
      }
    } catch (error) {
      this.host?.log.warn(`telegram: 贴纸 #${entry.seq} 原图下载失败：${error.message}`)
    }

    if (!thumbId) return
    // The static thumbnail is the photo fallback: Telegram refuses a sticker upload in the wrong
    // format, and an animated sticker's asset is not an image at all.
    try {
      const thumbBytes = media?.bytes && media.fileId === thumbId
        ? media.bytes
        : await this.downloadMedia(thumbId, MAX_STICKER_BYTES)
      if (thumbBytes) {
        const name = `thumb-${entry.seq}.jpg`
        fs.writeFileSync(path.join(this.stickerDir, name), thumbBytes)
        entry.thumb = name
      }
    } catch (error) {
      this.host?.log.warn(`telegram: 贴纸 #${entry.seq} 缩略图下载失败：${error.message}`)
    }
  }

  dropStickerFiles(entry) {
    if (!this.stickerDir) return
    for (const name of [entry.file, entry.thumb]) {
      if (!name) continue
      try {
        fs.rmSync(path.join(this.stickerDir, name), { force: true })
      } catch {
        // a leftover file is harmless
      }
    }
  }

  stickerBytes(entry, which = 'file') {
    const name = entry?.[which]
    if (!name || !this.stickerDir) return null
    try {
      return fs.readFileSync(path.join(this.stickerDir, name))
    } catch {
      return null
    }
  }

  /** Finds a saved sticker by handle (`#3`, `3`, `s3`), file id, set name, emoji or label. */
  findSticker(input) {
    const all = [...this.stickers.values()].sort((a, b) => a.seq - b.seq)
    if (!all.length) return { missing: '还没有收藏到贴纸：别人发一张，这里就自动存下来。' }
    const raw = asText(input).trim()
    if (!raw || raw === 'last' || raw === '最新') {
      return { entry: [...all].sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))[0] }
    }
    const seq = Number(raw.replace(/^[#sS]/, ''))
    if (Number.isInteger(seq) && seq > 0) {
      const bySeq = all.find((item) => item.seq === seq)
      if (bySeq) return { entry: bySeq }
    }
    const exact = all.find((item) => item.uniqueId === raw || item.fileId === raw || item.file === raw)
    if (exact) return { entry: exact }
    const needle = raw.toLowerCase()
    const matches = all.filter(
      (item) =>
        (item.emoji && item.emoji.includes(raw)) ||
        String(item.setId ?? '').toLowerCase().includes(needle) ||
        String(item.file ?? '').toLowerCase().includes(needle),
    )
    if (matches.length === 1) return { entry: matches[0] }
    if (matches.length > 1) return { candidates: matches.slice(-8) }
    return { missing: `没有编号或名字对得上 ${raw} 的贴纸。` }
  }

  /** file_id first (no upload, no size limit), then the saved asset, then its thumbnail as a photo. */
  async sendSavedSticker(chatId, entry) {
    const problems = []
    if (entry.fileId) {
      try {
        await tgCall(this.token, this.apiBase, 'sendSticker', { chat_id: chatId, sticker: entry.fileId })
        this.sent += 1
        this.noteOutbound(chatId)
        return `已发到 Telegram（${chatId}）：贴纸 #${entry.seq}${entry.emoji ? ` ${entry.emoji}` : ''}${entry.setId ? `（${entry.setId}）` : ''}。${this.waitingHint(chatId)}`
      } catch (error) {
        problems.push(error.message)
      }
    }
    const bytes = this.stickerBytes(entry)
    if (bytes) {
      try {
        const mime = entry.kind === 'static' ? 'image/webp' : entry.kind === 'video' ? 'video/webm' : 'application/x-tgsticker'
        await this.postForm('sendSticker', (form) => {
          form.append('chat_id', chatId)
          form.append('sticker', new Blob([bytes], { type: mime }), entry.file)
        })
        this.sent += 1
        this.noteOutbound(chatId)
        return `已发到 Telegram（${chatId}）：贴纸 #${entry.seq}（上传本地文件）。${this.waitingHint(chatId)}`
      } catch (error) {
        problems.push(error.message)
      }
    }
    const thumb = this.stickerBytes(entry, 'thumb')
    if (thumb) {
      try {
        await this.postForm('sendPhoto', (form) => {
          form.append('chat_id', chatId)
          form.append('photo', new Blob([thumb], { type: 'image/jpeg' }), `sticker-${entry.seq}.jpg`)
        })
        this.sent += 1
        this.noteOutbound(chatId)
        return `这个贴纸 Telegram 不让原样重发，改发了它的静态图（贴纸 #${entry.seq}）。${this.waitingHint(chatId)}`
      } catch (error) {
        problems.push(error.message)
      }
    }
    throw new Error(problems.join('；') || '这张贴纸没有可发的文件')
  }

  listStickers(input, limit) {
    const all = [...this.stickers.values()].sort((a, b) => b.seq - a.seq)
    if (!all.length) return '还没有收藏到贴纸：别人发一张，这里就自动存下来。'
    const needle = asText(input).trim().toLowerCase()
    const picked = needle
      ? all.filter(
          (item) =>
            String(item.emoji ?? '').includes(needle) ||
            String(item.setId ?? '').toLowerCase().includes(needle) ||
            String(item.uniqueId ?? '').toLowerCase().includes(needle),
        )
      : all
    const shown = picked.slice(0, limit)
    if (!shown.length) return `没有匹配 ${input} 的贴纸，现在一共 ${all.length} 张。`
    const lines = shown.map((item) => {
      const kind = item.kind === 'static' ? '静态' : item.kind === 'animated' ? '动图' : '视频'
      return `#${item.seq}${item.emoji ? ` ${item.emoji}` : ''} ${kind}${item.setId ? ` ${item.setId}` : ''} · ${item.count} 次 · ${formatSize(item.bytes || 0)}${item.file ? '' : ' · 文件没存下来'}`
    })
    const tail = picked.length > shown.length ? `\n……还有 ${picked.length - shown.length} 张，用 query 缩小范围。` : ''
    return `${lines.join('\n')}\n共 ${all.length} 张。发其中一张：tg_send_sticker，sticker 给 #编号。${tail}`
  }

  tools() {
    const handlers = {
      tg_unread: async (args) => this.readUnread(args),
      tg_send: async (args) => {
        const text = asText(args?.text).trim()
        const photoArg = asText(args?.photo).trim()
        const fileArg = asText(args?.file).trim()
        if (!text && !photoArg && !fileArg) return '没有内容可发：给 text、photo 或 file。'
        if (!this.token) return 'Telegram 还没配置 bot token。'
        const chatId = this.resolveChat(args?.chatId ?? args?.chat)
        if (!chatId) return this.chatHint()
        if (!this.allows(String(chatId))) return `会话 ${chatId} 不在 allow 名单里，拒绝发送。`
        try {
          if (fileArg) return await this.sendFiles(chatId, fileArg, text)
          if (photoArg) {
            const photo = this.readPhoto(photoArg)
            return await this.sendPhoto(chatId, photo, text)
          }
          await tgCall(this.token, this.apiBase, 'sendMessage', {
            chat_id: chatId,
            text,
            disable_web_page_preview: true,
          })
          this.sent += 1
          this.noteOutbound(chatId)
          return `已发到 Telegram（${chatId}）。${this.waitingHint(chatId)}`
        } catch (error) {
          return `发送失败：${error.message}`
        }
      },
      tg_send_sticker: async (args) => {
        if (!this.token) return 'Telegram 还没配置 bot token。'
        const found = this.findSticker(args?.sticker)
        if (found.missing) return found.missing
        if (found.candidates) {
          const list = found.candidates.map((item) => `#${item.seq}${item.emoji ? ` ${item.emoji}` : ''}${item.setId ? ` ${item.setId}` : ''}`)
          return `对得上好几张，说清是哪张：${list.join('、')}。`
        }
        const chatId = this.resolveChat(args?.chatId ?? args?.chat)
        if (!chatId) return this.chatHint()
        if (!this.allows(String(chatId))) return `会话 ${chatId} 不在 allow 名单里，拒绝发送。`
        try {
          return await this.sendSavedSticker(chatId, found.entry)
        } catch (error) {
          return `发送失败：${error.message}`
        }
      },
      tg_stickers: async (args) => {
        const limit = Math.max(1, Math.min(50, Number(args?.limit ?? 20) || 20))
        return this.listStickers(args?.query, limit)
      },
    }
    return Object.values(TG_TOOL_DECLS).map((decl) => ({ ...decl, handler: handlers[decl.name] }))
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

  // ---- unread buffer: group chatter waits here instead of waking the model ----
  loadUnread() {
    if (!this.unreadFile) return
    try {
      const parsed = JSON.parse(fs.readFileSync(this.unreadFile, 'utf8'))
      this.unread = Array.isArray(parsed?.items) ? parsed.items : []
      this.unreadPushedAt = Number(parsed?.pushedAt) || 0
      this.unreadSeq = Number(parsed?.seq) || 0
      this.unreadDropped = Number(parsed?.dropped) || 0
      // 旧版本没给每条缓存写 seq：按顺序回填，保证游标读取不会漏掉历史条目。
      for (const item of this.unread) {
        if (typeof item.seq !== 'number') {
          this.unreadSeq += 1
          item.seq = this.unreadSeq
        } else {
          this.unreadSeq = Math.max(this.unreadSeq, item.seq)
        }
      }
    } catch {
      this.unread = []
    }
  }

  saveUnread() {
    if (!this.unreadFile) return
    try {
      fs.writeFileSync(this.unreadFile, `${JSON.stringify({ items: this.unread, pushedAt: this.unreadPushedAt, seq: this.unreadSeq, dropped: this.unreadDropped }, null, 2)}\n`, 'utf8')
    } catch {
      // keep it in memory for this run
    }
  }

  get unreadMode() {
    const raw = String(this.setting('unreadMode', this.cfg.unreadMode) ?? 'off').trim().toLowerCase()
    return raw === 'all-group-buffered' || raw === 'all' ? 'all' : 'off'
  }

  get unreadPushCount() {
    return Math.max(0, Math.round(Number(this.setting('unreadPushCount', this.cfg.unreadPushCount) ?? 8)))
  }

  get unreadPushMinutes() {
    return Math.max(0, Math.round(Number(this.setting('unreadPushMinutes', this.cfg.unreadPushMinutes) ?? 30)))
  }

  get unreadMax() {
    return Math.max(10, Math.round(Number(this.setting('unreadMax', this.cfg.unreadMax) ?? 200)))
  }

  bufferUnread(entry) {
    this.unreadSeq += 1
    this.unread.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ts: new Date().toISOString(),
      seq: this.unreadSeq,
      ...entry,
    })
    if (this.unread.length > this.unreadMax) {
      const drop = this.unread.length - this.unreadMax
      this.unread = this.unread.slice(-this.unreadMax)
      this.unreadDropped += drop
    }
    this.saveUnread()
    void this.maybePushUnread()
  }

  async maybePushUnread() {
    if (!this.unread.length) return
    const count = this.unread.length
    const oldest = Date.parse(this.unread[0].ts) || Date.now()
    const byCount = this.unreadPushCount > 0 && count >= this.unreadPushCount
    const byAge = this.unreadPushMinutes > 0 && Date.now() - oldest >= this.unreadPushMinutes * 60_000
    if (!byCount && !byAge) return
    if (this.unreadPushedAt && Date.now() - this.unreadPushedAt < 5 * 60_000) return
    this.unreadPushedAt = Date.now()
    this.saveUnread()
    const convs = new Set(this.unread.map((item) => item.chatId)).size
    try {
      await this.host?.pushEvent(
        {
          type: `${WORLD_ID}.unread`,
          source: WORLD_ID,
          ts: new Date().toISOString(),
          origin: 'internal',
          ephemeral: true,
          text: `未读消息：${convs} 个会话共 ${count} 条。想看就用 tg_unread 一次取走。`,
          meta: { unread: count, conversations: convs },
        },
        { trigger: 'flush' },
      )
    } catch (error) {
      this.host?.log.warn(`telegram: 未读摘要推送失败 ${String(error)}`)
    }
  }

  /** Take the most recent `count` buffered lines of one chat (used as a mention's lead-in). */
  takeMentionContext(chatId, count = 5) {
    const pool = this.unread.filter((item) => String(item.chatId) === String(chatId))
    const taken = pool.slice(-count)
    if (!taken.length) return []
    const takenIds = new Set(taken.map((item) => item.id))
    this.unread = this.unread.filter((item) => !takenIds.has(item.id))
    this.saveUnread()
    return taken
  }

  readUnread(args = {}) {
    const conv = String(args?.conv ?? '').trim()
    const limit = Math.max(1, Math.min(50, Number(args?.limit ?? 20) || 20))
    const cursor = Number(args?.cursor ?? 0) || 0
    const pool = conv ? this.unread.filter((item) => String(item.chatId) === conv) : this.unread
    const startIdx = pool.findIndex((item) => (item.seq ?? 0) > cursor)
    if (startIdx === -1) {
      return {
        text: '没有未读。',
        nextCursor: cursor,
        remaining: this.unread.length,
        dropped: this.unreadDropped,
        took: 0,
      }
    }
    const taken = pool.slice(startIdx, startIdx + limit)
    const takenIds = new Set(taken.map((item) => item.id))
    this.unread = this.unread.filter((item) => !takenIds.has(item.id))
    this.saveUnread()
    // Reading a chat's backlog is what makes it a reply target, so a send without a chat answers
    // the group this batch came from rather than whichever chat is freshest.
    for (const item of taken) {
      const chatId = String(item.chatId)
      if (this.awaiting.has(chatId)) continue
      this.awaiting.set(chatId, {
        at: Date.parse(item.ts) || Date.now(),
        name: item.chatTitle || chatId,
        messageId: null,
      })
    }
    const lines = taken.map((item) => {
      const flags = [item.atMe ? '@我' : '', item.owner ? '主人' : ''].filter(Boolean).join(' ')
      return `[${item.ts.slice(11, 16)}] ${item.chatTitle || item.chatId}(${item.chatId}) · ${item.sender}${flags ? `（${flags}）` : ''}：${item.text}`
    })
    const left = this.unread.length
    const droppedNote = this.unreadDropped > 0 ? `（缓存期间已丢最旧 ${this.unreadDropped} 条）` : ''
    return {
      text: `${lines.join('\n')}\n\n已读 ${taken.length} 条${left ? `，还剩 ${left} 条未读` : '，没有未读了'}。${droppedNote}`,
      nextCursor: taken[taken.length - 1].seq,
      remaining: left,
      dropped: this.unreadDropped,
      took: taken.length,
    }
  }
  webUi() {
    const at = (key) => `worlds.${WORLD_ID}.${key}`
    return {
      label: 'Telegram',
      panels: [{ id: 'unread', title: '未读消息', description: '先攒着、等你要看时一次取走；@ 和主人私聊不攒。', getMethods: ['unread'] }],
      invoke: (panel, method) => (method === 'unread'
        ? { items: this.unread, count: this.unread.length, dropped: this.unreadDropped, oldest: this.unread[0]?.ts ?? null }
        : null),
      lamps: [
        {
          label: 'Telegram',
          state: this.state === 'online' ? 'online' : this.state === 'error' ? 'error' : 'offline',
          hint: this.hint || undefined,
        },
      ],
      badges: [
        { label: 'Bot', value: this.botUsername ? `@${this.botUsername}` : '未连接', tone: 'plain' },
        { label: '会话', value: this.chats.size, tone: 'plain' },
        { label: '收到', value: this.received, tone: 'plain' },
        { label: '发出', value: this.sent, tone: 'plain' },
        { label: '未读', value: this.unread.length, tone: 'plain' },
        { label: '贴纸', value: this.stickers.size, tone: 'plain' },
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
                description:
                  '允许说话的 chat id，空格或换行分隔（群聊是负数）。留空表示不限制，谁找到这个 bot 都能发消息。加了一个新群但没收到消息时，主人在那个群里发 /allow 就能放行。',
                'x-hot': true,
              },
              [at('replyChat')]: {
                type: 'string',
                title: '默认回话会话',
                description: '还没收到过消息时，tg_send 默认发到这个 chat id。',
                'x-hot': true,
              },
              [at('photoDirs')]: {
                type: 'string',
                title: '允许发图的目录',
                description:
                  'tg_send 只能从这里发图（绝对路径，多个用分号或换行分隔，支持 %USERPROFILE% 这类变量）。目录给到 tg_send 时会自动挑里面最新的一张。留空表示不许发图。',
                'x-hot': true,
              },
              [at('fileDirs')]: {
                type: 'string',
                title: '允许发文件的目录',
                description:
                  'tg_send 的 file（pdf / md / word / ppt / 表格 / 压缩包等任意文件）只能从这里发，路径写法同上一项。留空表示沿用「允许发图的目录」。',
                'x-hot': true,
              },
              [at('stickerEnabled')]: {
                type: 'boolean',
                title: '收藏收到的贴纸',
                description:
                  '开着时，别人发来的贴纸会存到本机（<数据目录>/telegram-stickers），之后可以用 tg_send_sticker 按 #编号 发回去。',
                'x-hot': true,
              },
              [at('stickerMax')]: {
                type: 'integer',
                title: '贴纸最多存多少张',
                minimum: 10,
                maximum: 2000,
                'x-hot': true,
                description: '默认 300，超出丢最久没出现的。',
              },
              [at('unreadMode')]: {
                type: 'string',
                title: '群消息未读模式',
                enum: ['off', 'all-group-buffered'],
                'x-hot': true,
                description:
                  'off（默认）保持旧行为。all-group-buffered：群里所有消息先攒进未读缓存、不进模型，只有 @ / 回复 / 关键词 / 主人命令立刻唤醒模型，被提及时把同会话最近 5 条一起带进这一轮。私聊不受影响。与「群里只在被提及时收」是两种互斥模式，二选一。',
              },
              [at('unreadPushCount')]: {
                type: 'integer',
                title: '未读攒多少条推一次摘要',
                minimum: 0,
                maximum: 200,
                'x-hot': true,
                description: '默认 8；0 表示不按条数推。摘要只报数字，不贴正文，正文用 tg_unread 一次取。',
              },
              [at('unreadPushMinutes')]: {
                type: 'integer',
                title: '未读放多久推一次摘要（分钟）',
                minimum: 0,
                maximum: 1440,
                'x-hot': true,
                description: '默认 30；0 表示不按时间推。',
              },
              [at('unreadMax')]: {
                type: 'integer',
                title: '未读最多存多少条',
                minimum: 10,
                maximum: 1000,
                'x-hot': true,
                description: '默认 200，超出丢最旧的。',
              },
              [at('groupMentionOnly')]: {
                type: 'boolean',
                title: '群里只在被提及时收',
                description:
                  '开启后：群里只有 @ 这个 bot、回复它的消息、或正文里出现关键词时才会进对话；被提及后，同一个人接下来若干条可免提及继续说话。私聊不受影响。',
                'x-hot': true,
              },
              [at('mentionKeywords')]: {
                type: 'string',
                title: '关键词提及',
                description: '正文里出现这些词就算 @ 了（逗号或空格分隔），比如「大肥鱼、肥鱼」。留空表示只认 @ 和回复。',
                'x-hot': true,
              },
              [at('continuityCount')]: {
                type: 'number',
                title: '连续放行条数',
                description: '一次提及后，同一个人最多能连续发几条（1–20）。模型在这期间回复的话，会按剩余额度补一批，额度逐次递减。',
                'x-hot': true,
              },
              [at('continuityWindowSec')]: {
                type: 'number',
                title: '连续放行时间窗（秒）',
                description: '超过这么多秒没说话，连续性就失效（10–3600），默认 120。',
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
  tools: Object.values(TG_TOOL_DECLS),
  events: [
    {
      type: 'telegram.message',
      description: {
        zh: '人在 Telegram 上发来的一条消息（只来自 allow 名单里的会话）；群聊和频道会带上名字与 id。',
        en: 'One message the person sent on Telegram, from an allow-listed chat only; a group or channel carries its title and id.',
      },
      trigger: 'flush',
    },
    {
      type: 'telegram.unread',
      description: {
        zh: '群里的未读攒够条数或放够时间后的摘要，只说有多少条，正文用 tg_unread 取。',
        en: 'A summary once buffered group messages reach a count or an age; the body is read with tg_unread.',
      },
      trigger: 'flush',
    },
    {
      type: 'telegram.joined',
      description: {
        zh: 'bot 被拉进一个还不在白名单里的会话，带群名和群 id，提示怎么放行。',
        en: 'The bot was added to a chat that is not on the allow list yet, with its title, id and how to let it in.',
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
    photoDirs: '',
    fileDirs: '',
    stickerEnabled: true,
    stickerMax: DEFAULT_STICKER_MAX,
    groupMentionOnly: false,
    mentionKeywords: '',
    continuityCount: DEFAULT_CONTINUITY,
    continuityWindowSec: DEFAULT_WINDOW_SEC,
    apiBase: DEFAULT_API_BASE,
    unreadMode: 'off',
    unreadPushCount: 8,
    unreadPushMinutes: 30,
    unreadMax: 200,
  }),
  describe: DESCRIBE,
  create: (ctx) => new TelegramWorld({ cfg: ctx?.cfg, ctx }),
}

export default definition
