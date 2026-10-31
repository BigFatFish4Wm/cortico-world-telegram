/**
 * Per-conversation coalescer for inbound Telegram messages.
 *
 * The World decides what one event says; this module only decides when one chat's pending
 * messages become one batch. Chats stay independent, arrival order is preserved, and a batch is
 * never dropped: a failed `onFlush` puts its messages back in front of anything that arrived
 * meanwhile, and the next idle tick tries again.
 *
 * Batch clocks come from each item's `at` (when the update arrived), not from when `enqueue` was
 * called, so a slow attachment download cannot stretch the gap between two messages of one burst.
 *
 * The maximum wait is not a second timer. Every arm takes the earlier of
 * `lastAt + windowMs` and `firstAt + maxWaitMs`, so new messages can postpone the flush by at
 * most `maxWaitMs - (now - firstAt)`; a stream that never goes quiet still flushes on time.
 *
 * The four limits may be passed as numbers or as functions; a function is resolved on every use,
 * which is what lets the World's settings take effect without rebuilding the batcher.
 */

const DEFAULT_WINDOW_MS = 1000
const DEFAULT_MAX_WAIT_MS = 3000
const DEFAULT_MAX_MESSAGES = 8
const DEFAULT_MAX_CHARS = 2400
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024

export class MessageBatcher {
  /**
   * @param {object} options
   * @param {(key: string, items: unknown[]) => Promise<void>} options.onFlush
   * @param {number|(() => number)} [options.windowMs] idle gap that closes a batch
   * @param {number|(() => number)} [options.maxWaitMs] hard deadline counted from a batch's first message
   * @param {number|(() => number)} [options.maxMessages]
   * @param {number|(() => number)} [options.maxChars] cap on the text a batch may carry
   * @param {number|(() => number)} [options.maxBytes] cap on attachment bytes a batch may hold
   * @param {{ warn?: (line: string) => void }} [options.log]
   */
  constructor(options = {}) {
    this.opts = options
    this.onFlush = options.onFlush
    this.log = options.log ?? {}
    /** conversation key → batch state; see `createState`. */
    this.batches = new Map()
    this.stopped = false
  }

  /** A limit, read fresh on every use so a settings change applies at the next message. */
  num(name, fallback) {
    const raw = this.opts[name]
    const value = Number(typeof raw === 'function' ? raw() : raw)
    return Number.isFinite(value) && value > 0 ? value : fallback
  }

  get windowMs() {
    return this.num('windowMs', DEFAULT_WINDOW_MS)
  }

  get maxWaitMs() {
    return Math.max(this.windowMs, this.num('maxWaitMs', DEFAULT_MAX_WAIT_MS))
  }

  get maxMessages() {
    return Math.max(1, Math.round(this.num('maxMessages', DEFAULT_MAX_MESSAGES)))
  }

  get maxChars() {
    return Math.max(1, Math.round(this.num('maxChars', DEFAULT_MAX_CHARS)))
  }

  get maxBytes() {
    return this.num('maxBytes', DEFAULT_MAX_BYTES)
  }

  /** How many conversations currently hold unsent messages. */
  get pending() {
    return this.batches.size
  }

  pendingCount(key) {
    return this.batches.get(key)?.items.length ?? 0
  }

  /**
   * Adds one message to its chat's batch. `urgent` first closes whatever is pending for that chat,
   * then sends this message alone, so a command or a mention never swallows the lines before it.
   * `weight` is the byte size of the message's attachments, counted against `maxBytes`.
   */
  async enqueue(key, item, { urgent = false, weight = 0 } = {}) {
    if (this.stopped) return false

    if (urgent) {
      await this.flush(key)
      const single = this.createState(key, arrivalOf(item))
      this.add(single, item, weight)
      this.batches.set(key, single)
      await this.flush(key)
      return true
    }

    let state = this.batches.get(key)
    if (!state) {
      state = this.createState(key, arrivalOf(item))
      this.batches.set(key, state)
    }
    this.add(state, item, weight)

    if (state.items.length >= this.maxMessages || state.chars >= this.maxChars || state.bytes >= this.maxBytes) {
      await this.flush(key)
      return true
    }
    this.arm(state)
    return true
  }

  createState(key, at) {
    return { key, items: [], chars: 0, bytes: 0, firstAt: at, lastAt: at, timer: null, flushing: false }
  }

  add(state, item, weight) {
    state.items.push(item)
    state.lastAt = Math.max(state.lastAt, arrivalOf(item))
    state.chars += Number(item?.chars) || String(item?.body ?? '').length
    state.bytes += Math.max(0, Number(weight) || 0)
  }

  /** One timer per batch, re-aimed on every message but never past the batch's hard deadline. */
  arm(state) {
    if (this.stopped || state.flushing) return
    this.clearTimer(state)
    const deadline = Math.min(state.lastAt + this.windowMs, state.firstAt + this.maxWaitMs)
    state.timer = setTimeout(() => {
      state.timer = null
      void this.flush(state.key)
    }, Math.max(0, deadline - Date.now()))
    state.timer.unref?.()
  }

  clearTimer(state) {
    if (!state?.timer) return
    clearTimeout(state.timer)
    state.timer = null
  }

  /** Sends one chat's batch now; returns false when there was nothing to send or it failed. */
  async flush(key) {
    const state = this.batches.get(key)
    if (!state || state.flushing || state.items.length === 0) return false

    state.flushing = true
    this.clearTimer(state)
    // Take the batch but keep the state, so messages arriving during the send append to it.
    const items = state.items
    const chars = state.chars
    const bytes = state.bytes
    state.items = []
    state.chars = 0
    state.bytes = 0

    try {
      await this.onFlush(state.key, items)
    } catch (error) {
      state.items = items.concat(state.items)
      state.chars = chars + state.chars
      state.bytes = bytes + state.bytes
      state.flushing = false
      this.log.warn?.(`合并投递失败，${state.items.length} 条留在队列里重试：${error?.message ?? error}`)
      this.arm(state)
      return false
    }

    state.flushing = false
    if (state.items.length === 0) {
      this.batches.delete(key)
      return true
    }
    // Whatever arrived during the send starts a new batch with a fresh deadline.
    const at = Date.now()
    state.firstAt = at
    state.lastAt = at
    this.arm(state)
    return true
  }

  async flushAll() {
    for (const key of [...this.batches.keys()]) {
      await this.flush(key)
    }
  }

  /** Stops taking work, then makes one attempt at everything staged for shutdown. */
  async stop() {
    this.stopped = true
    for (const state of this.batches.values()) this.clearTimer(state)
    await this.flushAll()
  }
}

/** When the update reached the World; `enqueue` time stands in when the item carries none. */
function arrivalOf(item) {
  const at = Number(item?.at)
  return Number.isFinite(at) && at > 0 ? at : Date.now()
}
