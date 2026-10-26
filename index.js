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
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024
const MAX_CAPTION = 1024
const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp)$/i
const MIME_BY_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
}
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
    this.chats = new Map()
    this.chatsFile = typeof options.ctx?.dataDir === 'string' && options.ctx.dataDir
      ? path.join(options.ctx.dataDir, 'telegram-chats.json')
      : null
    this.chatsLoaded = false
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
    this.loadChats()

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

    this.rememberChat(chat, message.from, chat.type)

    // In a group the chat id is the group, so the person speaking can only be recognised by
    // their own user id. The owner is the owner in every chat they are allowed into.
    const fromId = message.from?.id ?? null
    const owner = this.isOwner(chatId) || (fromId !== null && this.isOwner(String(fromId)))

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
    // Names repeat and can be edited; the numeric id is the only stable identity in a group.
    const sender = fromId === null ? who : `${who}(id:${fromId})`
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
    const quoted = this.quoteOf(message.reply_to_message)
    const quote = quoted
      ? `「回复 ${quoted.name}${quoted.fromId === null ? '' : `(id:${quoted.fromId})`}：${quoted.text}」`
      : ''

    this.host?.log.info(
      `telegram: 收到 ${kind} ${sender}（${chatId}，${role}）${quoted ? ' [回复]' : ''}：${(text || label).slice(0, 40)}`,
    )

    await this.host?.pushEvent(
      {
        type: `${WORLD_ID}.message`,
        source: WORLD_ID,
        ts: new Date().toISOString(),
        origin: 'external',
        text: `【Telegram ${kind} ${sender}（${role}）】${quote}${body}`,
        senderKey: chatId,
        meta: {
          chatId,
          messageId: message.message_id,
          fromId,
          fromName: who,
          fromUsername: message.from?.username ?? null,
          role: owner ? 'owner' : 'guest',
          hasMedia: Boolean(media),
          replyTo: quoted ?? undefined,
        },
        blobs,
      },
      { trigger: 'flush' },
    )
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

  /** Directories a photo may come from; `%VAR%` is expanded, `;` or newline separates entries. */
  get photoDirs() {
    const raw = asText(this.setting('photoDirs', this.cfg.photoDirs))
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

  /** A numeric id, `last`, or part of a chat title ("小窝"). */
  resolveChat(value) {
    const raw = asText(value).trim()
    if (!raw || raw === 'last') return this.lastChatId || this.replyChat
    if (/^-?\d+$/.test(raw)) return raw
    const needle = raw.toLowerCase()
    const matches = [...this.chats.values()].filter((c) => String(c.title ?? '').toLowerCase().includes(needle))
    return matches.length === 1 ? matches[0].id : null
  }

  chatHint() {
    const names = [...this.chats.values()].map((c) => `${c.title}(${c.id})`)
    return names.length ? `先说清楚发给谁，见过的会话有：${names.join('、')}` : '还没有人给这个 bot 发过消息。'
  }

  /**
   * Turns the tool's `photo` argument into bytes. A directory means "the newest image inside it".
   * Everything outside `photoDirs` is refused, so a model cannot mail arbitrary local files out.
   */
  readPhoto(input) {
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
        .filter((name) => IMAGE_EXT.test(name))
        .map((name) => path.join(target, name))
        .map((file) => ({ file, mtime: fs.statSync(file).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)[0]
      if (!newest) throw new Error(`目录里没有图片：${input}`)
      target = newest.file
      stat = fs.statSync(target)
    }

    if (!IMAGE_EXT.test(target)) throw new Error('只支持图片：jpg / png / webp / gif / bmp')
    if (stat.size > MAX_UPLOAD_BYTES) throw new Error(`图片太大（${Math.round(stat.size / 1024 / 1024)} MB，上限 50 MB）`)

    const dirs = this.photoDirs
    if (!dirs.length) throw new Error('还没有配置「允许发图的目录」')
    const real = fs.realpathSync(target).toLowerCase()
    const inside = dirs.some((dir) => {
      try {
        const realDir = fs.realpathSync(dir).toLowerCase()
        return real === realDir || real.startsWith(realDir + path.sep)
      } catch {
        return false
      }
    })
    if (!inside) throw new Error(`这个路径不在允许发图的目录里：${target}`)

    return {
      bytes: fs.readFileSync(target),
      name: path.basename(target),
      mime: MIME_BY_EXT[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
    }
  }

  async sendPhoto(chatId, photo, caption) {
    const method = photo.bytes.length > MAX_MEDIA_BYTES ? 'sendDocument' : 'sendPhoto'
    const field = method === 'sendPhoto' ? 'photo' : 'document'
    const form = new FormData()
    form.append('chat_id', chatId)
    if (caption) form.append('caption', caption.slice(0, MAX_CAPTION))
    form.append(field, new Blob([photo.bytes], { type: photo.mime }), photo.name)

    const res = await fetch(`${this.apiBase}/bot${this.token}/${method}`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(60000),
    })
    const data = await res.json().catch(() => null)
    if (!data || data.ok !== true) {
      throw new Error(`${method}: ${data?.description || `HTTP ${res.status}`}`)
    }
    this.sent += 1
    return `已发到 Telegram（${chatId}）：${photo.name}，${Math.round(photo.bytes.length / 1024)} KB${caption ? '，带说明' : ''}。`
  }

  tools() {
    return [
      {
        name: 'tg_send',
        description: [
          'Send a line, or one local image, to a Telegram chat through this bot.',
          'text goes as a message; with photo it becomes the caption.',
          'photo is an absolute path to an image file, or a directory — then the newest image inside it is sent.',
          'It must live under one of the directories allowed in this World settings; anything else is refused.',
          'chatId or chat picks the target: a numeric chat id, "last", or part of a chat title such as 小窝.',
          'With neither, it answers the chat that last wrote to you.',
        ].join(' '),
        tags: ['speak'],
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', maxLength: MAX_TEXT, description: 'Text to send, or the caption when photo is set.' },
            photo: { type: 'string', maxLength: 512, description: 'Absolute path of an image file or a directory (the newest image inside is used).' },
            chatId: { type: 'string', maxLength: 64, description: 'Optional chat id, "last", or part of a chat title.' },
            chat: { type: 'string', maxLength: 64, description: 'Optional chat title such as 小窝.' },
          },
        },
        handler: async (args) => {
          const text = asText(args?.text).trim()
          const photoArg = asText(args?.photo).trim()
          if (!text && !photoArg) return '没有内容可发：给 text 或 photo。'
          if (!this.token) return 'Telegram 还没配置 bot token。'
          const chatId = this.resolveChat(args?.chatId ?? args?.chat)
          if (!chatId) return this.chatHint()
          if (!this.allows(String(chatId))) return `会话 ${chatId} 不在 allow 名单里，拒绝发送。`
          try {
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
              [at('photoDirs')]: {
                type: 'string',
                title: '允许发图的目录',
                description:
                  'tg_send 只能从这里发图（绝对路径，多个用分号或换行分隔，支持 %USERPROFILE% 这类变量）。目录给到 tg_send 时会自动挑里面最新的一张。留空表示不许发图。',
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
