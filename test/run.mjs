/**
 * Standalone test: a fake Telegram Bot API on loopback + a fake Host, then the real World.
 *
 * Runs with node 22+: `node test/run.mjs`
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { TelegramWorld, definition } from '../index.js'

const TOKEN = 'TESTTOKEN'
const CHAT_ID = '424242'

function startFakeTelegram() {
  const sent = []
  const pending = []
  let waiter = null
  const receivedPaths = []
  const state = { rejectStickerFileId: false, rejectStickerUpload: false }

  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/file/bot')) {
      res.setHeader('content-type', 'image/jpeg')
      res.end(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
      return
    }
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks)
      const method = req.url.split('/').pop()
      receivedPaths.push(method)
      const isJson = String(req.headers['content-type'] || '').includes('json')
      res.setHeader('content-type', 'application/json')
      const fail = (errorCode, description) => {
        res.statusCode = 400
        res.end(JSON.stringify({ ok: false, error_code: errorCode, description }))
      }

      if (method === 'sendPhoto' || method === 'sendDocument') {
        sent.push({ method, raw, contentType: req.headers['content-type'] })
        res.end(JSON.stringify({ ok: true, result: { message_id: 900 + sent.length } }))
        return
      }

      if (method === 'sendSticker') {
        if (isJson) {
          if (state.rejectStickerFileId) {
            fail(400, 'Bad Request: wrong file identifier/HTTP URL specified')
            return
          }
          sent.push({ method, ...JSON.parse(raw.toString('utf8')) })
        } else {
          if (state.rejectStickerUpload) {
            fail(400, 'Bad Request: STICKER_VIDEO_... invalid')
            return
          }
          sent.push({ method, raw, contentType: req.headers['content-type'] })
        }
        res.end(JSON.stringify({ ok: true, result: { message_id: 900 + sent.length } }))
        return
      }

      const payload = raw.length ? JSON.parse(raw.toString('utf8')) : {}

      if (method === 'getMe') {
        res.end(JSON.stringify({ ok: true, result: { id: 1, is_bot: true, username: 'coo_test_bot' } }))
        return
      }
      if (method === 'getFile') {
        res.end(JSON.stringify({ ok: true, result: { file_id: payload.file_id, file_size: 4, file_path: 'photos/1.jpg' } }))
        return
      }
      if (method === 'getUpdates') {
        const flush = () => {
          if (pending.length === 0) return false
          const batch = pending.splice(0, pending.length)
          res.end(JSON.stringify({ ok: true, result: batch }))
          return true
        }
        if (!flush()) {
          waiter = () => {
            waiter = null
            flush()
          }
        }
        return
      }
      if (method === 'sendMessage') {
        sent.push(payload)
        res.end(JSON.stringify({ ok: true, result: { message_id: 900 + sent.length } }))
        return
      }
      res.statusCode = 404
      res.end(JSON.stringify({ ok: false, error_code: 404, description: 'not found' }))
    })
  })

  let updateId = 0
  server.pushRaw = (update) => {
    updateId += 1
    pending.push({ update_id: updateId, ...update })
    if (waiter) waiter()
  }
  server.pushUpdate = (message) => {
    server.pushRaw({ message })
  }
  server.sent = sent
  server.paths = receivedPaths
  server.state = state

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

function fakeHost() {
  const events = []
  return {
    events,
    log: {
      info: (line) => process.env.DEBUG && console.log('[info]', line),
      warn: (line) => process.env.DEBUG && console.warn('[warn]', line),
      error: (line) => console.error('[error]', line),
      debug: () => {},
    },
    store: { range: () => [], latestCursor: () => 0 },
    modelFacts: {},
    async pushEvent(event) {
      events.push(event)
      return { cursor: events.length, ...event, origin: event.origin ?? 'external' }
    },
  }
}

async function waitFor(predicate, label, timeoutMs = 4000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`timeout waiting for ${label}`)
}

const server = await startFakeTelegram()
const apiBase = `http://127.0.0.1:${server.address().port}`
const host = fakeHost()
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-world-'))
const GROUP_ID = '-100999'
const shotsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-shots-'))
const shotOld = path.join(shotsDir, 'old.jpg')
const shotNew = path.join(shotsDir, 'new.png')
fs.writeFileSync(shotOld, Buffer.from([1, 2, 3]))
fs.writeFileSync(shotNew, Buffer.from([4, 5, 6, 7]))
const oldTime = new Date(Date.now() - 60_000)
fs.utimesSync(shotOld, oldTime, oldTime)

const world = definition.create({
  cfg: {
    enabled: true,
    token: TOKEN,
    owner: CHAT_ID,
    guestMode: '朋友可聊天',
    allow: `${CHAT_ID} ${GROUP_ID}`,
    replyChat: '',
    photoDirs: shotsDir,
    apiBase,
  },
  dataDir,
})

assert.deepEqual(definition.defaults().apiBase, 'https://api.telegram.org')
assert.equal(definition.id, 'telegram')

await world.start(host)
assert.ok(server.paths.includes('getMe'), 'getMe is called on start')

server.pushUpdate({
  message_id: 11,
  from: { id: Number(CHAT_ID), is_bot: false, first_name: 'Jim', username: 'jim' },
  chat: { id: Number(CHAT_ID), type: 'private' },
  date: 1700000000,
  text: '回家路上买点猫粮',
})

await waitFor(() => host.events.length === 1, 'inbound event')
const [event] = host.events
assert.equal(event.type, 'telegram.message')
assert.equal(event.senderKey, CHAT_ID)
assert.equal(event.origin, 'external')
assert.match(event.text, /回家路上买点猫粮/)
assert.equal(event.meta.chatId, CHAT_ID)
assert.equal(event.meta.fromName, 'Jim')

const sendTool = world.tools().find((tool) => tool.name === 'tg_send')
assert.equal(sendTool.name, 'tg_send')
const receipt = await sendTool.handler({ text: '买到了' })
assert.match(String(receipt), /已发到 Telegram/)
const sentSoFar = server.sent.length
assert.equal(server.sent[sentSoFar - 1].chat_id, CHAT_ID)
assert.equal(server.sent[sentSoFar - 1].text, '买到了')

// /id answers any chat with its own id, without waking the bot
server.pushUpdate({
  message_id: 12,
  from: { id: 999, is_bot: false, first_name: 'Stranger' },
  chat: { id: 999, type: 'private' },
  date: 1700000001,
  text: '/id',
})
await waitFor(() => server.sent.length === sentSoFar + 1, '/id reply')
assert.match(server.sent.at(-1).text, /chat id：999/)
assert.equal(server.sent.at(-1).chat_id, '999')
assert.equal(host.events.length, 1, '/id does not become an event')

// a chat outside the allow list stays silent
server.pushUpdate({
  message_id: 13,
  from: { id: 777, is_bot: false, first_name: 'Other' },
  chat: { id: 777, type: 'private' },
  date: 1700000002,
  text: '在吗',
})
await new Promise((resolve) => setTimeout(resolve, 150))
assert.equal(host.events.length, 1, 'unknown chat is ignored')

// the owner can add it from inside Telegram
server.pushUpdate({
  message_id: 14,
  from: { id: Number(CHAT_ID), is_bot: false, first_name: 'Jim' },
  chat: { id: Number(CHAT_ID), type: 'private' },
  date: 1700000003,
  text: '/allow 777',
})
await waitFor(() => server.sent.at(-1)?.text?.includes('已加入白名单'), '/allow receipt')
assert.match(server.sent.at(-1).text, /777/)
assert.ok(fs.existsSync(path.join(dataDir, 'telegram-allow.json')), 'overlay file written')

server.pushUpdate({
  message_id: 15,
  from: { id: 777, is_bot: false, first_name: 'Other' },
  chat: { id: 777, type: 'private' },
  date: 1700000004,
  text: '现在可以了吗',
})
await waitFor(() => host.events.length === 2, 'newly allowed chat')
assert.match(host.events[1].text, /现在可以了吗/)
assert.match(host.events[1].text, /朋友，不是主人/)
assert.equal(host.events[1].meta.role, 'guest')
assert.match(host.events[0].text, /主人/)

// a guest cannot edit the allow list
server.pushUpdate({
  message_id: 16,
  from: { id: 777, is_bot: false, first_name: 'Other' },
  chat: { id: 777, type: 'private' },
  date: 1700000005,
  text: '/deny 424242',
})
await waitFor(() => server.sent.at(-1)?.text?.includes('只有主人的账号'), 'guest admin refused')
assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'telegram-allow.json'), 'utf8')), { added: ['777'], removed: [] })

// a photo becomes one event with the image bytes attached
server.pushUpdate({
  message_id: 18,
  from: { id: Number(CHAT_ID), is_bot: false, first_name: 'Jim' },
  chat: { id: Number(CHAT_ID), type: 'private' },
  date: 1700000007,
  photo: [
    { file_id: 'small', file_unique_id: 'u1', width: 90, height: 90, file_size: 4 },
    { file_id: 'big', file_unique_id: 'u2', width: 800, height: 800, file_size: 4 },
  ],
  caption: '看这个',
})
await waitFor(() => host.events.length === 3, 'photo event')
const photoEvent = host.events[2]
assert.match(photoEvent.text, /\[图片\]/)
assert.match(photoEvent.text, /看这个/)
assert.equal(photoEvent.meta.hasMedia, true)
assert.equal(photoEvent.blobs.length, 1)
assert.equal(photoEvent.blobs[0].mime, 'image/jpeg')
assert.equal(photoEvent.blobs[0].bytes.length, 4)
assert.equal(photoEvent.blobs[0].fallbackText, '[图片]')

// a chat title learnt from a message can be used as the target
server.pushUpdate({
  message_id: 19,
  from: { id: Number(CHAT_ID), is_bot: false, first_name: 'Jim' },
  chat: { id: Number(GROUP_ID), type: 'supergroup', title: '小窝' },
  date: 1700000008,
  text: '群里冒个泡',
})
await waitFor(() => host.events.length === 4, 'group message')
const groupEvent = host.events[3]
assert.match(groupEvent.text, /\(id:424242\)/, 'group messages carry the sender id, not just a name')
assert.equal(groupEvent.meta.fromId, 424242)
assert.match(groupEvent.text, /（主人）/m, 'the owner is the owner in a group too')
assert.match(host.events[0].text, /\(id:424242\)/, 'private messages carry the id too')
const sentBeforeChat = server.sent.length
const chatReceipt = await sendTool.handler({ text: '来了', chat: '小窝' })
assert.match(String(chatReceipt), /已发到 Telegram/)
assert.equal(server.sent[sentBeforeChat].chat_id, GROUP_ID)

// a reply carries what it answers: who wrote it and the start of that line
assert.ok(!host.events[0].text.includes('「回复'), 'a plain message carries no quote')
server.pushUpdate({
  message_id: 20,
  from: { id: Number(CHAT_ID), is_bot: false, first_name: 'Jim' },
  chat: { id: Number(CHAT_ID), type: 'private' },
  date: 1700000009,
  text: '这条是回复',
  reply_to_message: {
    message_id: 11,
    from: { id: 1, is_bot: true, first_name: 'BigFatFish' },
    text: '买到了',
  },
})
await waitFor(() => host.events.length === 5, 'reply event')
const replyEvent = host.events[4]
assert.match(replyEvent.text, /「回复 BigFatFish[(]id:1[)]：买到了」/)
assert.match(replyEvent.text, /这条是回复/)
assert.equal(replyEvent.meta.replyTo.name, 'BigFatFish')
assert.equal(replyEvent.meta.replyTo.messageId, 11)
assert.equal(replyEvent.meta.replyTo.fromId, 1)

// photo: send a file inside the allowed directory
const photoReceipt = await sendTool.handler({ text: '截图', photo: shotNew, chat: '小窝' })
assert.match(String(photoReceipt), /已发到 Telegram/)
assert.match(String(photoReceipt), /new\.png/)
const photoCall = server.sent.at(-1)
assert.equal(photoCall.method, 'sendPhoto')
const multipart = photoCall.raw.toString('latin1')
const multipartText = photoCall.raw.toString('utf8')
assert.match(multipart, /name="chat_id"/)
assert.ok(multipart.includes(GROUP_ID), 'chat id goes in the multipart body')
assert.ok(multipartText.includes('截图'), 'text becomes the caption')
assert.ok(multipart.includes('filename="new.png"'))

// a directory means "the newest image inside it"
const dirReceipt = await sendTool.handler({ photo: shotsDir, chat: '小窝' })
assert.match(String(dirReceipt), /new\.png/)

// a path outside the allowed directories is refused
const outside = path.join(dataDir, 'outside.jpg')
fs.writeFileSync(outside, Buffer.from([9]))
const refused = await sendTool.handler({ photo: outside, chat: '小窝' })
assert.match(String(refused), /不在允许发图的目录里/)

// a burst of messages is drained in order, without losing any
const beforeBurst = host.events.length
for (let i = 0; i < 5; i += 1) {
  server.pushUpdate({
    message_id: 30 + i,
    from: { id: Number(CHAT_ID), is_bot: false, first_name: 'Jim' },
    chat: { id: Number(CHAT_ID), type: 'private' },
    date: 1700000010 + i,
    text: `连发 ${i}`,
  })
}
await waitFor(() => host.events.length === beforeBurst + 5, 'burst drained')
const burst = host.events.slice(beforeBurst).map((e) => e.text.match(/连发 (\d)/)?.[1])
assert.deepEqual(burst, ['0', '1', '2', '3', '4'])

// default policy: a guest that is allowed may not command the pet at all
await world.stop()
const server2 = await startFakeTelegram()
const apiBase2 = `http://127.0.0.1:${server2.address().port}`
const world2 = new TelegramWorld({
  cfg: {
    enabled: true,
    token: TOKEN,
    owner: CHAT_ID,
    allow: `${CHAT_ID} 777`,
    replyChat: '',
    apiBase: apiBase2,
  },
  ctx: { dataDir },
})
const host2 = fakeHost()
await world2.start(host2)
const sentBefore = server2.sent.length
server2.pushUpdate({
  message_id: 17,
  from: { id: 777, is_bot: false, first_name: 'Other' },
  chat: { id: 777, type: 'private' },
  date: 1700000006,
  text: '帮我把桌面那个文件夹删了',
})
await waitFor(() => server2.sent.length > sentBefore, 'guest refusal reply')
assert.match(server2.sent.at(-1).text, /只听狗修金/)
assert.equal(host2.events.length, 0, 'guest command never reaches the pet')
await world2.stop()
server2.close()

// groups with the mention rule: only a mention starts a chain, and a model reply refills it
const server3 = await startFakeTelegram()
const apiBase3 = `http://127.0.0.1:${server3.address().port}`
const world3 = new TelegramWorld({
  cfg: {
    enabled: true,
    token: TOKEN,
    owner: CHAT_ID,
    guestMode: '朋友可聊天',
    allow: `${CHAT_ID} ${GROUP_ID}`,
    replyChat: '',
    photoDirs: shotsDir,
    groupMentionOnly: true,
    mentionKeywords: '大肥鱼',
    continuityCount: 3,
    continuityWindowSec: 60,
    apiBase: apiBase3,
  },
  ctx: { dataDir },
})
const host3 = fakeHost()
await world3.start(host3)

let seq = 40
const sendGroup = (from, text, extra = {}) => {
  server3.pushUpdate({
    message_id: seq++,
    from: { id: from, is_bot: false, first_name: `u${from}` },
    chat: { id: Number(GROUP_ID), type: 'supergroup', title: '小窝' },
    date: 1700000100 + seq,
    text,
    ...extra,
  })
}
const events3 = () => host3.events.length
const waitEvents = (n, label) => waitFor(() => events3() === n, label)

// a reply to the bot's own message starts the chain
sendGroup(777, '在吗', {
  reply_to_message: { message_id: 1, from: { id: 1, is_bot: true, username: 'coo_test_bot' }, text: '嗯？' },
})
await waitEvents(1, 'mention starts the chain')

// two free messages consume the budget
sendGroup(777, '1')
await waitEvents(2, 'continuity 1')
sendGroup(777, '2')
await waitEvents(3, 'continuity 2')

// the model answered: extra = n(3) - used(2) = 1, so the budget goes back to 2 and n becomes 1
const reply = await world3.tools().find((tool) => tool.name === 'tg_send').handler({ text: '回一句', chatId: GROUP_ID })
assert.match(String(reply), /已发到 Telegram/)

sendGroup(777, '3')
await waitEvents(4, 'refilled continuity')
sendGroup(777, '4')
await waitEvents(5, 'continuity exhausted')

// answering again keeps a floor of one: max(1, n(1) - used(2)) = 1
await world3.tools().find((tool) => tool.name === 'tg_send').handler({ text: '再回一句', chatId: GROUP_ID })

sendGroup(777, '5')
await waitEvents(6, 'floor keeps one more message')
sendGroup(777, '6')
await new Promise((resolve) => setTimeout(resolve, 150))
assert.equal(events3(), 6, 'the floor is spent once, then the chain ends')

// a stranger without a chain is dropped too
sendGroup(888, '我也是朋友')
await new Promise((resolve) => setTimeout(resolve, 150))
assert.equal(events3(), 6, 'a non-mentioned stranger is dropped')

// a keyword counts as a mention, and opens a chain for that person
sendGroup(999, '大肥鱼在吗')
await waitEvents(7, 'keyword mention')
sendGroup(999, '那我说第二句')
await waitEvents(8, 'chain from the keyword')

// an @ still works, and resets the chain
sendGroup(777, '@coo_test_bot 我回来了')
await waitEvents(9, 'mention reopens the chain')
sendGroup(777, '这次能收到吗')
await waitEvents(10, 'continuity after the second mention')

await world3.stop()
server3.close()

// unreadMode='all-group-buffered'：群普通消息先攒缓存，@ 立刻唤醒并带同会话最近 5 条。
const server4 = await startFakeTelegram()
const apiBase4 = `http://127.0.0.1:${server4.address().port}`
const dataDir4 = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-world4-'))
const world4 = new TelegramWorld({
  cfg: {
    enabled: true,
    token: TOKEN,
    owner: CHAT_ID,
    guestMode: '朋友可聊天',
    allow: `${CHAT_ID} ${GROUP_ID}`,
    replyChat: '',
    unreadMode: 'all-group-buffered',
    unreadMax: 10,
    unreadPushCount: 0,
    unreadPushMinutes: 0,
    apiBase: apiBase4,
  },
  ctx: { dataDir: dataDir4 },
})
const host4 = fakeHost()
await world4.start(host4)

let seq4 = 100
const sendGroup4 = (from, text, extra = {}) => {
  server4.pushUpdate({
    message_id: seq4++,
    from: { id: from, is_bot: false, first_name: `u${from}` },
    chat: { id: Number(GROUP_ID), type: 'supergroup', title: '小窝' },
    date: 1700000200 + seq4,
    text,
    ...extra,
  })
}
const events4 = () => host4.events.length
const waitEvents4 = (n, label) => waitFor(() => events4() === n, label)

// 群普通消息不唤醒模型
sendGroup4(777, '普通一句')
await new Promise((resolve) => setTimeout(resolve, 150))
assert.equal(events4(), 0, 'unreadMode=all 的群普通消息不产生事件')

// tg_unread 只返回并移除实际给出的那一条，nextCursor 前进
const unreadTool4 = world4.tools().find((tool) => tool.name === 'tg_unread')
const first = await unreadTool4.handler({ limit: 5 })
assert.equal(first.took, 1, '只有一条可读')
assert.match(first.text, /普通一句/)
assert.ok(Number(first.nextCursor) > 0, 'nextCursor 前进')
assert.equal(first.remaining, 0)
assert.equal(world4.unread.length, 0, '取走的条目已从缓存移除')

// 再攒 6 条，然后 @：正文带同会话最近 5 条前文（最旧的那条被顶掉）
for (let i = 1; i <= 6; i += 1) sendGroup4(777, `攒第${i}条`)
await new Promise((resolve) => setTimeout(resolve, 150))
assert.equal(events4(), 0, '仍然不唤醒')

sendGroup4(777, '在吗', {
  reply_to_message: { message_id: 1, from: { id: 1, is_bot: true, username: 'coo_test_bot' }, text: '嗯？' },
})
await waitEvents4(1, '@ 唤醒')
const mentionEvent4 = host4.events[0]
assert.match(mentionEvent4.text, /（前文）/)
assert.match(mentionEvent4.text, /攒第2条/, '前文含同会话最近第 2 条')
assert.match(mentionEvent4.text, /攒第6条/, '前文含同会话最近第 6 条')
assert.match(mentionEvent4.text, /在吗/, '当前行仍在正文里')
assert.ok(!mentionEvent4.text.includes('攒第1条'), '最旧的攒第1条不在最近 5 条里')

// 超 unreadMax 丢最旧：此刻缓存剩 1 条，再灌 12 条 → 丢 3 条
for (let i = 1; i <= 12; i += 1) sendGroup4(777, `溢出${i}`)
await new Promise((resolve) => setTimeout(resolve, 150))
assert.equal(world4.unreadDropped, 3, '超出 unreadMax 的部分计入 dropped')
assert.equal(world4.unread.length, 10, '缓存被截到 unreadMax')

await world4.stop()
server4.close()

// 默认 off：旧行为不变（群普通消息直接进事件，不攒缓存）——world1 已覆盖，这里再显式点一条
const server5 = await startFakeTelegram()
const apiBase5 = `http://127.0.0.1:${server5.address().port}`
const dataDir5 = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-world5-'))
const world5 = new TelegramWorld({
  cfg: { enabled: true, token: TOKEN, owner: CHAT_ID, guestMode: '朋友可聊天', allow: `${CHAT_ID} ${GROUP_ID}`, replyChat: '', apiBase: apiBase5 },
  ctx: { dataDir: dataDir5 },
})
const host5 = fakeHost()
await world5.start(host5)
server5.pushUpdate({
  message_id: 200,
  from: { id: Number(CHAT_ID), is_bot: false, first_name: 'Jim' },
  chat: { id: Number(GROUP_ID), type: 'supergroup', title: '小窝' },
  date: 1700000300,
  text: '默认模式直接进',
})
await waitFor(() => host5.events.length === 1, 'default off group message')
assert.match(host5.events[0].text, /默认模式直接进/)
assert.equal(world5.unread.length, 0, '默认 off 不攒缓存')
await world5.stop()
server5.close()

// an empty token never reaches the network
const offline = new TelegramWorld({ cfg: { token: '' } })
await offline.start(fakeHost())
assert.equal(offline.state, 'error')
assert.equal(await offline.tools().find((tool) => tool.name === 'tg_send').handler({ text: 'hi' }), 'Telegram 还没配置 bot token。')

await world.stop()
server.close()

// ---- 多群：每个群都进得来，回复按「等得最久的先回」分给各个群 ----
const server6 = await startFakeTelegram()
const apiBase6 = `http://127.0.0.1:${server6.address().port}`
const dataDir6 = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-world6-'))
const GROUP_A = '-100777'
const GROUP_B = '-100888'
const world6 = new TelegramWorld({
  cfg: {
    enabled: true,
    token: TOKEN,
    owner: CHAT_ID,
    guestMode: '朋友可聊天',
    allow: `${CHAT_ID} ${GROUP_A} ${GROUP_B}`,
    replyChat: '',
    apiBase: apiBase6,
  },
  ctx: { dataDir: dataDir6 },
})
const host6 = fakeHost()
await world6.start(host6)

let seq6 = 300
const push6 = (chatId, text) => server6.pushUpdate({
  message_id: seq6++,
  from: { id: Number(CHAT_ID), is_bot: false, first_name: '阿梦' },
  chat: { id: Number(chatId), type: 'supergroup', title: chatId === GROUP_A ? '小窝' : '摸鱼群' },
  date: 1700001000 + seq6,
  text,
})

push6(GROUP_A, '小窝里的第一句')
await waitFor(() => host6.events.length === 1, '第一个群的事件')
assert.match(host6.events[0].text, /「小窝」\(-100777\)/, '群事件带群名和群 id，模型才知道回哪个群')
assert.equal(host6.events[0].meta.chatTitle, '小窝')

push6(GROUP_B, '摸鱼群里的第一句')
await waitFor(() => host6.events.length === 2, '第二个群的事件')
assert.match(host6.events[1].text, /「摸鱼群」\(-100888\)/, '第二个群也带自己的群名和 id')

const send6 = world6.tools().find((tool) => tool.name === 'tg_send')
const first6 = String(await send6.handler({ text: '回小窝' }))
assert.match(first6, /已发到 Telegram（-100777）/, '不带 chat 时回等得最久的那个群')
assert.match(first6, /另有 1 个会话在等回复/, '回执点名还在等的群，模型能接着回')
assert.equal(server6.sent.at(-1).chat_id, GROUP_A)
const second6 = String(await send6.handler({ text: '回摸鱼群' }))
assert.match(second6, /已发到 Telegram（-100888）/, '第二个群同样回得到，不会被最后说话的那个吃掉')
assert.equal(server6.sent.at(-1).chat_id, GROUP_B)

// 缓存模式读出来的群也算「在等回复」，并带上 chat id
server6.pushUpdate({
  message_id: seq6++,
  from: { id: 777, is_bot: false, first_name: 'u777' },
  chat: { id: Number(GROUP_B), type: 'supergroup', title: '摸鱼群' },
  date: 1700001100,
  text: '群里又冒一句',
})
await waitFor(() => host6.events.length === 3, '第二个群的第三条')
await send6.handler({ text: '回摸鱼群' })
assert.equal(world6.awaiting.size, 0, '回过的会话不再排队')

await world6.stop()
server6.close()

// 频道：Telegram 把它的更新叫 channel_post，只收 message 的话这种会话整个是哑的
const server6b = await startFakeTelegram()
const apiBase6b = `http://127.0.0.1:${server6b.address().port}`
const CHANNEL_ID = '-100555'
const world6b = new TelegramWorld({
  cfg: { enabled: true, token: TOKEN, owner: CHAT_ID, guestMode: '朋友可聊天', allow: `${CHAT_ID} ${CHANNEL_ID}`, replyChat: '', apiBase: apiBase6b },
  ctx: { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'tg-world6b-')) },
})
const host6b = fakeHost()
await world6b.start(host6b)
server6b.pushRaw({
  channel_post: {
    message_id: 500,
    chat: { id: Number(CHANNEL_ID), type: 'channel', title: '公告板' },
    date: 1700001200,
    text: '频道第一帖',
  },
})
await waitFor(() => host6b.events.length === 1, '频道帖子的事件')
assert.match(host6b.events[0].text, /【Telegram 频道 「公告板」\(-100555\)】/)
assert.equal(host6b.events[0].meta.chatTitle, '公告板')
const channelReply = String(await world6b.tools().find((tool) => tool.name === 'tg_send').handler({ text: '收到' }))
assert.match(channelReply, /已发到 Telegram（-100555）/, '不带 chat 也回到频道')
await world6b.stop()
server6b.close()

// ---- 新群：主人能在群里直接放行；被拉进群时先收到一条带 id 的提示 ----
const server7 = await startFakeTelegram()
const apiBase7 = `http://127.0.0.1:${server7.address().port}`
const dataDir7 = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-world7-'))
const GROUP_C = '-100999888'
const world7 = new TelegramWorld({
  cfg: { enabled: true, token: TOKEN, owner: CHAT_ID, guestMode: '朋友可聊天', allow: CHAT_ID, replyChat: '', apiBase: apiBase7 },
  ctx: { dataDir: dataDir7 },
})
const host7 = fakeHost()
await world7.start(host7)

const push7 = (chat, fromId, text) => server7.pushUpdate({
  message_id: Math.floor(Math.random() * 100000),
  from: { id: fromId, is_bot: false, first_name: fromId === Number(CHAT_ID) ? '阿梦' : '路人' },
  chat,
  date: 1700002000,
  text,
})
const groupC = { id: Number(GROUP_C), type: 'supergroup', title: '新群' }

// bot 被拉进新群：一条 internal 事件带群名和 id
server7.pushRaw({
  my_chat_member: {
    chat: groupC,
    from: { id: Number(CHAT_ID), is_bot: false, first_name: '阿梦' },
    date: 1700002000,
    old_chat_member: { status: 'left', user: { id: 1, is_bot: true, first_name: 'bot' } },
    new_chat_member: { status: 'member', user: { id: 1, is_bot: true, first_name: 'bot' } },
  },
})
await waitFor(() => host7.events.length === 1, '被拉进群的事件')
assert.equal(host7.events[0].type, 'telegram.joined')
assert.match(host7.events[0].text, new RegExp(GROUP_C))
assert.match(host7.events[0].text, /新群/)

// 群还没放行：主人说话会收到一次带 id 的提醒，但不进对话
push7(groupC, Number(CHAT_ID), '这个群能用吗')
await waitFor(() => server7.sent.length >= 1, '未放行群的提醒')
assert.match(server7.sent.at(-1).text, /还没进白名单/)
assert.match(server7.sent.at(-1).text, new RegExp(`/allow ${GROUP_C}`))
assert.equal(host7.events.length, 1, '没放行的群不产生对话事件')

// 主人就在这个群里发 /allow（不带 id = 当前会话）
push7(groupC, Number(CHAT_ID), '/allow')
await waitFor(() => server7.sent.at(-1)?.text?.includes('已加入白名单'), '群里 /allow 的回执')
assert.match(server7.sent.at(-1).text, new RegExp(GROUP_C))
const overlay7 = JSON.parse(fs.readFileSync(path.join(dataDir7, 'telegram-allow.json'), 'utf8'))
assert.ok(overlay7.added.includes(GROUP_C), '/allow 把当前群写进了白名单')

// 放行之后这个群正常进对话
push7(groupC, 555, '现在能收到吗')
await waitFor(() => host7.events.length === 2, '放行后的群消息')
assert.match(host7.events[1].text, /现在能收到吗/)
assert.match(host7.events[1].text, /「新群」\(-100999888\)/)

// 朋友在群里发 /allow 依旧无效
push7(groupC, 555, `/allow ${GROUP_C}`)
await new Promise((resolve) => setTimeout(resolve, 150))
assert.ok(!JSON.parse(fs.readFileSync(path.join(dataDir7, 'telegram-allow.json'), 'utf8')).added.includes('555'))

await world7.stop()
server7.close()

// ---- 贴纸：收到的自动存，能按 #编号 发回去；file_id 失效就上传，再不行发静态图 ----
const server8 = await startFakeTelegram()
const apiBase8 = `http://127.0.0.1:${server8.address().port}`
const dataDir8 = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-world8-'))
const world8 = new TelegramWorld({
  cfg: { enabled: true, token: TOKEN, owner: CHAT_ID, guestMode: '朋友可聊天', allow: `${CHAT_ID} ${GROUP_ID}`, replyChat: '', apiBase: apiBase8 },
  ctx: { dataDir: dataDir8 },
})
const host8 = fakeHost()
await world8.start(host8)

server8.pushUpdate({
  message_id: 400,
  from: { id: Number(CHAT_ID), is_bot: false, first_name: '阿梦' },
  chat: { id: Number(CHAT_ID), type: 'private' },
  date: 1700003000,
  sticker: {
    file_id: 'STK1',
    file_unique_id: 'UNIQ1',
    type: 'regular',
    width: 512,
    height: 512,
    is_animated: false,
    is_video: false,
    emoji: '😺',
    set_name: 'Cats',
    thumbnail: { file_id: 'TH1', file_unique_id: 'TH1U', width: 320, height: 320, file_size: 4 },
  },
})
await waitFor(() => host8.events.length === 1, '贴纸事件')
const stickerEvent = host8.events[0]
assert.match(stickerEvent.text, /\[贴纸 😺 #1\]/, '事件里带贴纸句柄，模型能立刻发回去')
assert.equal(stickerEvent.meta.sticker, '#1')
assert.ok(fs.existsSync(path.join(dataDir8, 'telegram-stickers.json')), '贴纸索引落盘')
const stickerIndex = JSON.parse(fs.readFileSync(path.join(dataDir8, 'telegram-stickers.json'), 'utf8'))
assert.equal(stickerIndex.stickers.length, 1)
assert.equal(stickerIndex.stickers[0].fileId, 'STK1')
assert.equal(stickerIndex.stickers[0].setId, 'Cats')
assert.ok(fs.existsSync(path.join(dataDir8, 'telegram-stickers', 'sticker-1.webp')), '原图落盘')
assert.ok(fs.existsSync(path.join(dataDir8, 'telegram-stickers', 'thumb-1.jpg')), '缩略图落盘（静态图兜底用）')

// 同一张再来一次：不重复落盘，只加计数
server8.pushUpdate({
  message_id: 401,
  from: { id: Number(CHAT_ID), is_bot: false, first_name: '阿梦' },
  chat: { id: Number(CHAT_ID), type: 'private' },
  date: 1700003001,
  sticker: { file_id: 'STK1', file_unique_id: 'UNIQ1', is_animated: false, is_video: false, emoji: '😺', set_name: 'Cats' },
})
await waitFor(() => host8.events.length === 2, '同一张贴纸')
assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir8, 'telegram-stickers.json'), 'utf8')).stickers.length, 1)
assert.equal(world8.stickers.get('UNIQ1').count, 2)

const stickersTool = world8.tools().find((tool) => tool.name === 'tg_stickers')
const listed = String(await stickersTool.handler({}))
assert.match(listed, /#1 😺 静态 Cats/)
assert.match(listed, /共 1 张/)

const sendStickerTool = world8.tools().find((tool) => tool.name === 'tg_send_sticker')
const sentByFileId = String(await sendStickerTool.handler({ sticker: '#1', chatId: CHAT_ID }))
assert.match(sentByFileId, /贴纸 #1/)
assert.equal(server8.sent.at(-1).method, 'sendSticker')
assert.equal(server8.sent.at(-1).sticker, 'STK1', '优先用 file_id 原样重发')

// file_id 不认了（例如换了 bot）：改成上传本机存的那份
server8.state.rejectStickerFileId = true
const sentByUpload = String(await sendStickerTool.handler({ sticker: '1', chatId: CHAT_ID }))
assert.match(sentByUpload, /上传本地文件/)
assert.equal(server8.sent.at(-1).method, 'sendSticker')
assert.ok(server8.sent.at(-1).raw.toString('latin1').includes('filename="sticker-1.webp"'))

// 连上传都不行（动图/格式不合）：退成静态图
server8.state.rejectStickerUpload = true
const sentAsPhoto = String(await sendStickerTool.handler({ sticker: 'UNIQ1', chatId: CHAT_ID }))
assert.match(sentAsPhoto, /改发了它的静态图/)
assert.equal(server8.sent.at(-1).method, 'sendPhoto')

// 找不到就说清楚
assert.match(String(await sendStickerTool.handler({ sticker: '#99', chatId: CHAT_ID })), /没有编号或名字对得上/)

// 关掉收藏后不再存
const server8b = await startFakeTelegram()
const apiBase8b = `http://127.0.0.1:${server8b.address().port}`
const world8b = new TelegramWorld({
  cfg: { enabled: true, token: TOKEN, owner: CHAT_ID, guestMode: '朋友可聊天', allow: CHAT_ID, replyChat: '', stickerEnabled: false, apiBase: apiBase8b },
  ctx: { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'tg-world8b-')) },
})
const host8b = fakeHost()
await world8b.start(host8b)
server8b.pushUpdate({
  message_id: 402,
  from: { id: Number(CHAT_ID), is_bot: false, first_name: '阿梦' },
  chat: { id: Number(CHAT_ID), type: 'private' },
  date: 1700003100,
  sticker: { file_id: 'STK2', file_unique_id: 'UNIQ2', is_animated: false, is_video: false },
})
await waitFor(() => host8b.events.length === 1, '关掉收藏后的贴纸消息')
assert.equal(world8b.stickers.size, 0, 'stickerEnabled=false 不收藏')
assert.match(host8b.events[0].text, /\[贴纸\]/, '仍然是正常的贴纸消息')
await world8b.stop()
server8b.close()

await world8.stop()
server8.close()

// ---- 发文件：pdf / md / word / ppt 等任意文档，照样只能从允许的目录发 ----
const server9 = await startFakeTelegram()
const apiBase9 = `http://127.0.0.1:${server9.address().port}`
const dataDir9 = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-world9-'))
const docsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-docs-'))
const pdfPath = path.join(docsDir, 'report.pdf')
const mdPath = path.join(docsDir, 'notes.md')
const pptxPath = path.join(docsDir, 'slides.pptx')
fs.writeFileSync(mdPath, Buffer.from('# 标题\n正文'))
fs.writeFileSync(pdfPath, Buffer.from('%PDF-1.4 fake'))
fs.writeFileSync(pptxPath, Buffer.from('PK fake pptx'))
const oldDocTime = new Date(Date.now() - 120_000)
fs.utimesSync(mdPath, oldDocTime, oldDocTime)
fs.utimesSync(pdfPath, oldDocTime, oldDocTime)

const world9 = new TelegramWorld({
  cfg: {
    enabled: true,
    token: TOKEN,
    owner: CHAT_ID,
    guestMode: '朋友可聊天',
    allow: `${CHAT_ID} ${GROUP_ID}`,
    replyChat: '',
    fileDirs: docsDir,
    apiBase: apiBase9,
  },
  ctx: { dataDir: dataDir9 },
})
const host9 = fakeHost()
await world9.start(host9)
const send9 = world9.tools().find((tool) => tool.name === 'tg_send')

const pdfReceipt = String(await send9.handler({ file: pdfPath, text: '报告在这里', chatId: CHAT_ID }))
assert.match(pdfReceipt, /已发到 Telegram/)
assert.match(pdfReceipt, /report\.pdf/)
const pdfCall = server9.sent.at(-1)
assert.equal(pdfCall.method, 'sendDocument')
const pdfBody = pdfCall.raw.toString('latin1')
const pdfText = pdfCall.raw.toString('utf8')
assert.ok(pdfBody.includes('filename="report.pdf"'), '文件名原样带上')
assert.ok(pdfBody.includes(`name="chat_id"`))
assert.ok(pdfBody.includes(CHAT_ID))
assert.ok(pdfText.includes('报告在这里'), 'text 变成文件说明')
assert.ok(pdfBody.includes('application/pdf'), 'pdf 的 MIME 正确')

// md / pptx 也发得出去
const mdReceipt = String(await send9.handler({ file: mdPath, chatId: CHAT_ID }))
assert.match(mdReceipt, /notes\.md/)
assert.ok(server9.sent.at(-1).raw.toString('latin1').includes('text/markdown'))
const pptxReceipt = String(await send9.handler({ file: pptxPath, chatId: CHAT_ID }))
assert.match(pptxReceipt, /slides\.pptx/)
assert.ok(server9.sent.at(-1).raw.toString('latin1').includes('presentationml'))

// 给目录就发里面最新的那个
const newestDocReceipt = String(await send9.handler({ file: docsDir, chatId: CHAT_ID }))
assert.match(newestDocReceipt, /slides\.pptx/, '目录取最新的那个文件')

// 换行分隔多个文件，按顺序各发一条
const before9 = server9.sent.length
const manyReceipt = String(await send9.handler({ file: `${pdfPath}\n${mdPath}`, text: '两份', chatId: CHAT_ID }))
assert.match(manyReceipt, /report\.pdf/)
assert.match(manyReceipt, /notes\.md/)
assert.equal(server9.sent.length, before9 + 2, '两个文件两条 sendDocument')
assert.ok(server9.sent[before9].raw.toString('utf8').includes('两份'), '说明只跟第一条')
assert.ok(!server9.sent[before9 + 1].raw.toString('utf8').includes('两份'), '第二条不再重复说明')

// 允许目录之外的文件拒绝
const outsideDoc = path.join(dataDir9, 'secret.md')
fs.writeFileSync(outsideDoc, Buffer.from('# nope'))
const refused9 = String(await send9.handler({ file: outsideDoc, chatId: CHAT_ID }))
assert.match(refused9, /不在允许发文件的目录里/)
assert.match(refused9, /当前允许/)

// fileDirs 留空时沿用发图目录
const world9b = new TelegramWorld({
  cfg: { enabled: true, token: TOKEN, owner: CHAT_ID, guestMode: '朋友可聊天', allow: CHAT_ID, replyChat: '', photoDirs: docsDir, apiBase: apiBase9 },
  ctx: { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'tg-world9b-')) },
})
const host9b = fakeHost()
await world9b.start(host9b)
const fallbackReceipt = String(await world9b.tools().find((tool) => tool.name === 'tg_send').handler({ file: pdfPath, chatId: CHAT_ID }))
assert.match(fallbackReceipt, /已发到 Telegram/, '没配发文件目录时沿用发图目录')
await world9b.stop()

// 没配任何目录时给出可操作的错误
const world9c = new TelegramWorld({
  cfg: { enabled: true, token: TOKEN, owner: CHAT_ID, allow: CHAT_ID, replyChat: '', apiBase: apiBase9 },
  ctx: { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'tg-world9c-')) },
})
const host9c = fakeHost()
await world9c.start(host9c)
const noDirs = String(await world9c.tools().find((tool) => tool.name === 'tg_send').handler({ file: pdfPath, chatId: CHAT_ID }))
assert.match(noDirs, /还没有配置「允许发文件的目录」/)
await world9c.stop()

await world9.stop()
server9.close()

console.log('ok: 收消息→事件、tg_send→sendMessage、/id、/allow 白名单、未读缓存模式、多群回复分流、新群放行、频道、贴纸收藏与重发、发文件')
