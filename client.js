/**
 * 观测台：未读消息面板。只读；数字与正文都从 World 的 invoke('unread') 拿。
 * 群里没 @ 到 bot 的普通聊天先攒在这里，@ / 回复 / 关键词会立刻唤醒并把同会话最近 5 条一起带进去。
 */

function fmtTime(iso) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString([], { hour12: false })
  } catch {
    return String(iso)
  }
}

function cell(tag, text, align) {
  const el = document.createElement(tag)
  el.textContent = text
  el.style.padding = '4px 8px'
  if (align) el.style.textAlign = align
  return el
}

const unreadPanel = {
  async mount(ctx) {
    const sheet = ctx.ui.sheet({
      title: '未读消息',
      desc: '群里没 @ 到 bot 的普通聊天先攒在这里；@、回复、关键词会立刻唤醒并把同会话最近 5 条一起带进这一轮。',
    })
    const bar = ctx.ui.rowbar()
    const wrap = document.createElement('div')
    wrap.style.maxHeight = '480px'
    wrap.style.overflowY = 'auto'
    wrap.style.border = '1px solid rgba(127,127,127,.25)'
    wrap.style.borderRadius = '8px'

    const tableEl = document.createElement('table')
    tableEl.style.width = '100%'
    tableEl.style.borderCollapse = 'collapse'
    tableEl.style.fontSize = '12px'
    const head = document.createElement('thead')
    const hrow = document.createElement('tr')
    for (const [label, align] of [['时间', 'left'], ['会话', 'left'], ['发送者', 'left'], ['内容', 'left']]) {
      const th = cell('th', label, align)
      th.style.position = 'sticky'
      th.style.top = '0'
      th.style.background = 'var(--dsw-alias-bg-layer-2, #f4f4f5)'
      th.style.borderBottom = '1px solid rgba(127,127,127,.3)'
      hrow.append(th)
    }
    head.append(hrow)
    tableEl.append(head)
    const body = document.createElement('tbody')
    tableEl.append(body)
    wrap.append(tableEl)
    sheet.body.append(bar, wrap)
    ctx.root.appendChild(sheet.el)

    const render = (data) => {
      const items = Array.isArray(data?.items) ? data.items : []
      const dropped = Number(data?.dropped) || 0
      bar.replaceChildren(
        ctx.ui.chip(`${items.length} 条未读`),
        ctx.ui.chip(`最旧 ${fmtTime(data?.oldest)}`),
        dropped > 0 ? ctx.ui.chip(`已丢最旧 ${dropped} 条`, 'warn') : ctx.ui.chip('未丢', 'muted'),
      )
      body.replaceChildren()
      if (!items.length) {
        const tr = document.createElement('tr')
        tr.append(cell('td', '还没有未读。', 'left'))
        body.append(tr)
        return
      }
      for (const item of items) {
        const tr = document.createElement('tr')
        tr.style.borderTop = '1px solid rgba(127,127,127,.12)'
        const flags = [item.atMe ? '@我' : '', item.owner ? '主人' : ''].filter(Boolean).join(' ')
        const conv = item.chatTitle ? `${item.chatTitle}(${item.chatId})` : String(item.chatId ?? '')
        tr.append(
          cell('td', item.ts ? item.ts.slice(11, 16) : '—', 'left'),
          cell('td', conv, 'left'),
          cell('td', String(item.sender ?? '') + (flags ? `（${flags}）` : ''), 'left'),
          (() => {
            const td = cell('td', String(item.text ?? ''), 'left')
            td.style.whiteSpace = 'pre-wrap'
            td.style.wordBreak = 'break-word'
            return td
          })(),
        )
        body.append(tr)
      }
    }

    const load = async () => {
      try {
        render(await ctx.invoke('unread', []))
      } catch {
        // 面板离线也不影响其它功能
      }
    }
    void load()
    ctx.interval(load, 8000)
  },
}

export default { panels: { unread: unreadPanel } }
