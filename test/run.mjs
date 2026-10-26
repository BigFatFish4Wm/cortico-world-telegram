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

  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/file/bot')) {
      res.setHeader('content-type', 'image/jpeg')
      res.end(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
      return
    }
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      const method = req.url.split('/').pop()
      receivedPaths.push(method)
      const payload = body ? JSON.parse(body) : {}
      res.setHeader('content-type', 'application/json')

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

  server.pushUpdate = (message) => {
    pending.push({ update_id: pending.length + 1 + Math.floor(Math.random() * 1000), message })
    if (waiter) waiter()
  }
  server.sent = sent
  server.paths = receivedPaths

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

const world = definition.create({
  cfg: {
    enabled: true,
    token: TOKEN,
    owner: CHAT_ID,
    guestMode: '朋友可聊天',
    allow: CHAT_ID,
    replyChat: '',
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

const [sendTool] = world.tools()
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

// an empty token never reaches the network
const offline = new TelegramWorld({ cfg: { token: '' } })
await offline.start(fakeHost())
assert.equal(offline.state, 'error')
assert.equal(await offline.tools()[0].handler({ text: 'hi' }), 'Telegram 还没配置 bot token。')

await world.stop()
server.close()

console.log('ok: 收消息→事件、tg_send→sendMessage、/id、/allow 白名单')
