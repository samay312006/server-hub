import React, { useEffect, useRef, useState, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { getJSON, postJSON, delReq, patchJSON, streamChat, emit, on, fmtTime } from './api.js'
import Markdown from './Markdown.jsx'

export const SLASH = [
  { cmd: '/help', args: '', desc: 'List all commands', owner: false },
  { cmd: '/status', args: '', desc: 'PM2 process status', owner: true },
  { cmd: '/restart', args: '<process>', desc: 'Restart a PM2 process', owner: true },
  { cmd: '/stop', args: '<process>', desc: 'Stop a PM2 process', owner: true },
  { cmd: '/start', args: '<process>', desc: 'Start a PM2 process', owner: true },
  { cmd: '/logs', args: '<process> [lines]', desc: 'Tail PM2 logs', owner: true },
  { cmd: '/branch', args: '', desc: 'Branch (fork) this chat into a copy', owner: false },
  { cmd: '/btw', args: '<question>', desc: 'Side question — does not touch chat context', owner: false },
  { cmd: '/branches', args: '', desc: 'Git branches in workdir', owner: true },
  { cmd: '/git', args: '', desc: 'Git status of workdir', owner: true },
  { cmd: '/commits', args: '', desc: 'Recent commits', owner: true },
  { cmd: '/pending', args: '', desc: 'Pending WhatsApp approvals', owner: true },
  { cmd: '/confirm', args: '[id]', desc: 'Approve a WhatsApp approval', owner: true },
  { cmd: '/deny', args: '[id]', desc: 'Deny a WhatsApp approval', owner: true },
  { cmd: '/ongoing', args: '', desc: 'Running WhatsApp Claude jobs', owner: true },
  { cmd: '/cancel', args: '<id>', desc: 'Cancel a WhatsApp Claude job', owner: true },
  { cmd: '/override', args: '', desc: 'WhatsApp override-access status', owner: true },
  { cmd: '/tasks', args: '', desc: 'Console tasks (Claude Code)', owner: true },
  { cmd: '/wa', args: '', desc: 'WhatsApp connection status', owner: false },
  { cmd: '/code', args: '[path]', desc: 'Open VS Code in the active project', owner: true },
  { cmd: '/console', args: '[path]', desc: 'Open a terminal in the active project', owner: true },
  { cmd: '/explorer', args: '[path]', desc: 'Open File Explorer in the active project', owner: true },
  { cmd: '/export', args: '', desc: 'Download this chat as Markdown', owner: false },
  { cmd: '/compress', args: '', desc: 'Summarize older messages to shorten this chat', owner: false },
  { cmd: '/model', args: '<name>', desc: 'Switch model (haiku/sonnet/opus)', owner: false },
  { cmd: '/new', args: '', desc: 'Start a new chat', owner: false },
  { cmd: '/theme', args: '', desc: 'Cycle themes', owner: false },
  { cmd: '/dashboard', args: '', desc: 'Open the dashboard tab', owner: true },
  { cmd: '/params', args: '', desc: 'Open chat parameters', owner: false },
]

const CHIPS = [
  { icon: '📊', label: 'Server health report', prompt: 'Give me a quick health report of all hub services (PM2, WhatsApp, disk space).' },
  { icon: '📋', label: 'Recent log errors', prompt: 'Summarize the most recent errors across all PM2 logs.' },
  { icon: '💾', label: 'Disk & memory', prompt: 'Show current disk and memory usage on this machine.' },
  { icon: '🔁', label: 'Repo changes', prompt: 'What changed in the server-hub git repo in the last week?' },
]

let _id = 0
const nid = () => ++_id

const SR = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition)

export default function Chat({ role, model, getParams, visible, activeProject }) {
  const [items, setItems] = useState([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  useEffect(() => { emit('chat-streaming', { active: streaming }) }, [streaming])
  const [cmdSel, setCmdSel] = useState(0)
  const [showDown, setShowDown] = useState(false)
  const [attach, setAttach] = useState([])
  const [mic, setMic] = useState(false)
  const recRef = useRef(null)

  const sessionRef = useRef(localStorage.getItem('hub_session') || '')
  const convRef = useRef(localStorage.getItem('hub_conv') || '')
  const msgCountRef = useRef(0)
  const abortRef = useRef(null)
  const logRef = useRef(null)
  const inputRef = useRef(null)
  const turnStartRef = useRef(0)

  const upd = (id, patch) => setItems((it) => it.map((x) => (x.id === id ? { ...x, ...patch } : x)))
  const push = (item) => { const o = { id: nid(), ts: Date.now(), ...item }; setItems((it) => [...it, o]); return o.id }
  const addSys = (text) => push({ kind: 'sys', text })
  const addSysMd = (text) => push({ kind: 'sys', text, md: true })
  const addSysPre = (text) => push({ kind: 'pre', text })
  const addErr = (text) => push({ kind: 'err', text })

  // ---------- scroll ----------
  const nearBottom = () => { const el = logRef.current; return !el || el.scrollTop + el.clientHeight >= el.scrollHeight - 120 }
  useEffect(() => { const el = logRef.current; if (el && nearBottom()) el.scrollTop = el.scrollHeight })
  const onScroll = () => { const el = logRef.current; setShowDown(!!el && !nearBottom() && el.scrollHeight > el.clientHeight) }

  // ---------- conversations ----------
  const openConv = useCallback(async (id, { focus = true } = {}) => {
    try {
      const conv = await getJSON('/conversations/' + id)
      convRef.current = id
      sessionRef.current = ''
      localStorage.setItem('hub_conv', id)
      localStorage.removeItem('hub_session')
      msgCountRef.current = conv.messages.length
      setItems(conv.messages.map((m, i) => ({
        id: nid(), kind: m.role === 'user' ? 'user' : 'bot', text: m.text, ts: m.ts, midx: i, done: true,
      })))
      emit('conv-active', { id })
      emit('title', { title: conv.title || 'Untitled' })
      emit('switch-tab', { tab: 'chat' })
      if (focus) inputRef.current?.focus()
    } catch {}
  }, [])

  const newChat = useCallback(() => {
    sessionRef.current = ''; convRef.current = ''; msgCountRef.current = 0
    localStorage.removeItem('hub_session'); localStorage.removeItem('hub_conv')
    setItems([])
    emit('conv-active', { id: '' })
    emit('title', { title: 'Server Hub' })
    emit('usage-reset')
    emit('switch-tab', { tab: 'chat' })
    inputRef.current?.focus()
  }, [])

  useEffect(() => on('openConv', ({ id }) => openConv(id)), [openConv])
  useEffect(() => on('newChat', newChat), [newChat])
  useEffect(() => on('sendPrompt', ({ text }) => send(text)))
  useEffect(() => on('export', exportChat))
  useEffect(() => { const last = localStorage.getItem('hub_conv'); if (last) openConv(last, { focus: false }) }, [openConv])

  // ---------- edit / retry ----------
  async function editMsg(midx, text) {
    if (streaming || !convRef.current) return
    await postJSON(`/conversations/${convRef.current}/truncate`, { keep: midx })
    sessionRef.current = ''; localStorage.removeItem('hub_session')
    await openConv(convRef.current)
    setInput(text)
    requestAnimationFrame(() => autosize())
  }
  async function retryMsg(midx) {
    if (streaming || !convRef.current) return
    let prev = null
    try { prev = (await getJSON('/conversations/' + convRef.current)).messages[midx - 1] } catch {}
    if (!prev || prev.role !== 'user') return
    await postJSON(`/conversations/${convRef.current}/truncate`, { keep: midx - 1 })
    sessionRef.current = ''; localStorage.removeItem('hub_session')
    await openConv(convRef.current)
    send(prev.text)
  }

  function exportChat() {
    const md = items.filter((i) => i.kind === 'user' || i.kind === 'bot')
      .map((i) => (i.kind === 'user' ? '## 🧑 You\n\n' : '## ⚡ Hub\n\n') + i.text).join('\n\n---\n\n')
    const blob = new Blob(['# Server Hub chat export\n\n' + md], { type: 'text/markdown' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'hub-chat-' + new Date().toISOString().slice(0, 10) + '.md'
    a.click()
    URL.revokeObjectURL(a.href)
  }

  // ---------- attachments ----------
  async function addFiles(files) {
    if (role === 'guest') return
    for (const f of files) {
      if (f.size > 15e6) { emit('toast', { text: '❌ ' + f.name + ' too big (15MB max)' }); continue }
      const b64 = await new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.readAsDataURL(f) })
      try {
        const r = await (await postJSON('/upload', { name: f.name, dataBase64: b64 })).json()
        if (r.ok) setAttach((a) => [...a, { name: r.name, path: r.path }])
      } catch { emit('toast', { text: '❌ upload failed' }) }
    }
  }

  // ---------- voice input (Web Speech API) ----------
  const toggleMic = () => {
    if (mic) { try { recRef.current?.stop() } catch {} return }
    if (!SR) return
    const r = new SR()
    r.lang = navigator.language || 'en-US'
    r.interimResults = true
    r.continuous = true
    const base = input ? input.replace(/\s+$/, '') + ' ' : ''
    r.onresult = (e) => {
      let t = ''
      for (const res of e.results) t += res[0].transcript
      setInput(base + t)
      requestAnimationFrame(() => autosize())
    }
    r.onend = () => setMic(false)
    r.onerror = () => setMic(false)
    recRef.current = r
    setMic(true)
    try { r.start() } catch { setMic(false) }
  }

  // ---------- streaming send ----------
  async function send(text, { btw = false } = {}) {
    text = (text ?? input).trim()
    if (!text || streaming) return
    if (!btw && text.startsWith('/')) { if (await handleSlash(text)) return }
    if (mic) { try { recRef.current?.stop() } catch {} }
    if (!btw && attach.length) {
      text = '[Attached files saved on this machine — read them from disk when relevant:\n' +
        attach.map((a) => '- ' + a.path).join('\n') + ']\n\n' + text
      setAttach([])
    }
    setInput(''); autosize(true)

    const userId = push({ kind: 'user', text, btw, midx: btw ? null : msgCountRef.current })
    if (!btw) msgCountRef.current++
    const typingId = push({ kind: 'typing' })
    setStreaming(true)
    turnStartRef.current = Date.now()
    emit('mood', { mood: 'think' })
    abortRef.current = new AbortController()

    let botId = null, botText = '', lastToolId = null, errored = false
    const finishTool = () => { if (lastToolId) { upd(lastToolId, { done: true }); lastToolId = null } }
    const rmTyping = () => setItems((it) => it.filter((x) => x.id !== typingId))

    try {
      // For the first turn of a new project chat, prepend the project context to
      // the system prompt so Claude knows which folder it's operating in.
      const baseParams = getParams()
      const isNewSession = !btw && !sessionRef.current
      const effectiveParams = (isNewSession && activeProject && activeProject.id !== 'default')
        ? { ...baseParams, systemPrompt: ['You are in the "' + activeProject.name + '" project (' + activeProject.workdir + '). All file/git operations use this directory.', baseParams.systemPrompt].filter(Boolean).join('\n\n') }
        : baseParams
      await streamChat(
        {
          message: text,
          sessionId: btw ? '' : sessionRef.current,
          model,
          convId: btw ? undefined : (convRef.current || undefined),
          ephemeral: btw || undefined,
          params: effectiveParams,
        },
        {
          onMeta: (sid, cid) => {
            if (btw) return
            if (sid) { sessionRef.current = sid; localStorage.setItem('hub_session', sid) }
            if (cid) { convRef.current = cid; localStorage.setItem('hub_conv', cid); emit('conv-active', { id: cid }) }
          },
          onEvent: (ev) => {
            if (ev.type === 'text') {
              rmTyping(); finishTool()
              if (!botId) botId = push({ kind: 'bot', text: '', btw, live: true })
              botText += ev.text
              upd(botId, { text: botText })
            } else if (ev.type === 'tool') {
              rmTyping(); finishTool()
              if (botId) upd(botId, { live: false })
              botId = null
              lastToolId = push({ kind: 'tool', name: ev.name, input: '' })
            } else if (ev.type === 'tool_input') {
              if (lastToolId) { let pretty = ev.input; try { pretty = JSON.stringify(JSON.parse(ev.input), null, 2) } catch {}; upd(lastToolId, { input: pretty }) }
            } else if (ev.type === 'usage') {
              emit('usage', ev.usage)
            } else if (ev.type === 'error') {
              rmTyping(); finishTool(); errored = true
              addErr(ev.message)
            } else if (ev.type === 'done') {
              rmTyping(); finishTool()
              if (botId && botText) {
                upd(botId, { live: false, done: true, midx: btw ? null : msgCountRef.current })
                if (!btw) msgCountRef.current++
              }
              if (!btw) {
                emit('convs-dirty')
                emit('title', { title: text.slice(0, 40) || 'Chat' })
              }
            }
          },
        },
        abortRef.current.signal,
      )
      const took = Date.now() - turnStartRef.current
      emit('mood', { mood: errored ? 'error' : 'happy' })
      if (!errored && took > 20000) emit('celebrate')
      if (document.hidden && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try { new Notification('⚡ Hub finished', { body: (botText || 'Turn complete').slice(0, 140), icon: '/favicon.svg' }) } catch {}
      }
    } catch (e) {
      rmTyping(); finishTool()
      if (e.name === 'AbortError') addErr('Generation stopped')
      else { addErr('Connection error: ' + e.message); emit('mood', { mood: 'error' }) }
    }
    setStreaming(false)
    abortRef.current = null
  }

  // ---------- slash commands ----------
  const apiCmd = async (payload) => {
    try {
      const r = await postJSON('/command', payload)
      if (r.status === 403) return { ok: false, error: 'Owner-only command.' }
      return await r.json()
    } catch (e) { return { ok: false, error: e.message } }
  }

  async function handleSlash(text) {
    const parts = text.slice(1).trim().split(/\s+/)
    const c = '/' + (parts[0] || '').toLowerCase(), a1 = parts[1], a2 = parts[2]
    const def = SLASH.find((s) => s.cmd === c)
    if (!def) return false
    setInput(''); autosize(true)
    if (c !== '/btw') push({ kind: 'user', text })
    if (def.owner && role !== 'owner') { addSys('⛔ Owner-only command.'); return true }
    switch (c) {
      case '/help': {
        let out = '**Available commands**\n\n'
        for (const s of SLASH) { if (s.owner && role !== 'owner') continue; out += '`' + s.cmd + (s.args ? ' ' + s.args : '') + '` — ' + s.desc + (s.owner ? ' *(owner)*' : '') + '\n\n' }
        out += 'Anything else goes to Claude.'
        addSysMd(out); break }
      case '/new': newChat(); break
      case '/theme': emit('cycle-theme'); addSys('🎨 Theme switched.'); break
      case '/dashboard': emit('switch-tab', { tab: 'dashboard' }); break
      case '/params': emit('toggle-params'); break
      case '/export': exportChat(); addSys('💾 Chat exported.'); break
      case '/compress': {
        if (!convRef.current) { addSys('Nothing to compress yet — send a message first.'); break }
        addSys('🗜 Compressing earlier messages…')
        try {
          const r = await (await postJSON(`/conversations/${convRef.current}/compress`, {})).json()
          if (r.ok) { await openConv(convRef.current); emit('convs-dirty'); emit('toast', { text: '🗜 Compressed to ' + r.messages + ' messages' }) }
          else addSys('❌ ' + (r.error || 'compress failed'))
        } catch { addSys('❌ compress failed') }
        break
      }
      case '/model': emit('set-model', { query: a1 || '' }); break
      case '/branch': {
        if (!convRef.current) { addSys('Nothing to branch yet — send a message first, then /branch forks the chat.'); break }
        const r = await postJSON(`/conversations/${convRef.current}/fork`)
        if (!r.ok) { addSys('❌ Branch failed.'); break }
        const forked = await r.json()
        emit('convs-dirty')
        await openConv(forked.id)
        addSys('🌿 Branched into "' + (forked.title || 'copy') + '" — you are now on the copy; the original chat is untouched.')
        break }
      case '/btw': {
        const q = text.replace(/^\/btw\s*/i, '').trim()
        if (!q) { addSys("Usage: /btw <question>\nQuick side question answered out-of-band — it won't enter or disturb this chat's context, and is not saved."); break }
        send(q, { btw: true })
        break }
      case '/wa': {
        try { const s = await getJSON('/wa-status'); addSys('WhatsApp: ' + (s.ready ? '✅ connected' : s.needsQR ? '⚠️ needs QR scan' : '❌ ' + (s.status || 'offline'))) }
        catch { addSys('❌ Could not reach WA status.') }
        break }
      case '/status': {
        const r = await apiCmd({ cmd: 'pm2-list' })
        const list = r.list || []
        if (!list.length) { addSys(r.error || 'No PM2 processes.'); break }
        addSys(list.map((p) => {
          const mem = p.memory ? Math.round(p.memory / 1e6) + 'MB' : '—'
          const cpu = p.cpu != null ? p.cpu + '%' : '—'
          return (p.status === 'online' ? '🟢' : '🔴') + ' ' + p.name + ' — ' + p.status + ' · ' + cpu + ' · ' + mem + (p.restarts ? ' · ↺' + p.restarts : '')
        }).join('\n'))
        break }
      case '/restart': case '/stop': case '/start': {
        if (!a1) { addSys('Usage: ' + c + ' <process>'); break }
        const r = await apiCmd({ cmd: 'pm2-action', action: c.slice(1), name: a1 })
        addSys(r.ok ? '✅ ' + c.slice(1) + ' "' + a1 + '" done' : '❌ ' + (r.error || r.output || 'failed'))
        break }
      case '/logs': {
        if (!a1) { addSys('Usage: /logs <process> [lines]'); break }
        const r = await apiCmd({ cmd: 'logs', name: a1, lines: a2 || '30' })
        addSysPre(r.output || r.error || '(no output)'); break }
      case '/branches': { const r = await apiCmd({ cmd: 'git', action: 'branch' }); addSysPre(r.output || r.error || '(no output)'); break }
      case '/git': { const r = await apiCmd({ cmd: 'git', action: 'status' }); addSysPre(r.output || r.error || '(no output)'); break }
      case '/commits': { const r = await apiCmd({ cmd: 'git', action: 'log' }); addSysPre(r.output || r.error || '(no output)'); break }
      case '/code': case '/console': case '/explorer': {
        const app = c === '/code' ? 'vscode' : c === '/console' ? 'terminal' : 'explorer'
        const body = a1 ? { app, workdir: a1 } : { app }
        const r = await postJSON('/open', body)
        const d = await r.json().catch(() => ({}))
        addSys(d.ok ? (c === '/code' ? '🧑‍💻 VS Code opening on the server…' : c === '/console' ? '⌨️ Terminal opening on the server…' : '📂 Explorer opening on the server…') : '❌ ' + (d.error || 'failed'))
        break }
      case '/pending': {
        try { await showPending() } catch { addSys('❌ WhatsApp daemon unreachable.') }
        break }
      case '/tasks': {
        try {
          const d = await getJSON('/dashboard')
          const list = Object.values(d.tasks || {})
          addSys(list.length ? list.map((t) => (t.status === 'running' ? '⚙️' : t.status === 'completed' ? '✅' : '🛑') + ' ' + (t.description || t.id) + ' (' + t.status + ')').join('\n') : 'No console tasks recorded.')
        } catch { addSys('⛔ Not available.') }
        break }
      case '/ongoing': {
        try {
          const d = await getJSON('/wa/jobs')
          let out = '**WhatsApp Claude jobs** · model: `' + d.model + '`\n\n'
          out += d.running?.length ? d.running.map((j) => '⚙️ **#' + j.id + '** ' + j.label + ' · ' + j.elapsedSec + 's · ' + j.model + ' — `/cancel ' + j.id + '`').join('\n') + '\n' : '_No running jobs._\n'
          if (d.recent?.length) out += '\nRecent: ' + d.recent.map((j) => (j.status === 'done' ? '✅' : j.status === 'cancelled' ? '🛑' : '❌') + ' #' + j.id + ' ' + j.label).join(' · ')
          addSysMd(out)
        } catch { addSys('❌ WhatsApp daemon unreachable.') }
        break }
      case '/cancel': {
        if (!a1) { addSys('Usage: /cancel <job id> — see /ongoing for IDs.'); break }
        const r = await postJSON('/wa/jobs/cancel', { id: a1 })
        const d = await r.json().catch(() => ({}))
        addSys(r.ok ? '🛑 Cancelled #' + d.id + ' (' + (d.label || '') + ')' : '⚠️ ' + (d.error || 'Failed.'))
        break }
      case '/confirm': case '/deny': {
        const r = await postJSON('/wa/approvals/resolve', { id: a1 || '', action: c === '/confirm' ? 'confirm' : 'deny' })
        const d = await r.json().catch(() => ({}))
        addSys(r.ok ? (c === '/confirm' ? '✅ Approved' : '❌ Denied') + ' #' + (d.id || a1 || '') + (d.label ? ' — ' + d.label : '') : '⚠️ ' + (d.error || 'Failed.'))
        break }
      case '/override': {
        try {
          const d = await getJSON('/wa/override')
          addSys('🔐 Override password: ' + (d.passwordSet ? 'set ✓' : 'not set ✗') + '\nContacts with access (' + d.contacts.length + '):\n' + (d.contacts.length ? d.contacts.join('\n') : '(none)') + '\n\nRevoke via WhatsApp: /claude-override-revoke [chatId]')
        } catch { addSys('❌ WhatsApp daemon unreachable.') }
        break }
    }
    return true
  }

  async function showPending() {
    const list = await getJSON('/wa/approvals')
    if (!Array.isArray(list) || !list.length) { addSys('✅ No pending approvals.'); return }
    addSysMd(list.map((a) => '🔔 **#' + a.id + '** · ' + Math.round((Date.now() - a.createdAt) / 60000) + 'm ago — **' + a.label + '**\n' + String(a.description || '').slice(0, 140) + '\n`/confirm ' + a.id + '` · `/deny ' + a.id + '`').join('\n\n'))
  }

  // ---------- composer ----------
  function autosize(reset) {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    if (!reset) el.style.height = Math.min(el.scrollHeight, 160) + 'px'
  }
  const cmdItems = (input.startsWith('/') && !input.includes('\n') && !input.includes(' '))
    ? SLASH.filter((s) => (!s.owner || role === 'owner') && s.cmd.slice(1).startsWith(input.slice(1).toLowerCase()))
    : []
  const pickCmd = (i) => {
    const s = cmdItems[i]
    if (!s) return
    if (s.args) { setInput(s.cmd + ' '); inputRef.current?.focus() }
    else { setInput(''); send(s.cmd) }
  }

  const onKey = (e) => {
    if (cmdItems.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setCmdSel((s) => Math.min(s + 1, cmdItems.length - 1)); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setCmdSel((s) => Math.max(s - 1, 0)); return }
      if (e.key === 'Tab') { e.preventDefault(); pickCmd(cmdSel); return }
      if (e.key === 'Enter' && !e.shiftKey) {
        const typed = '/' + input.slice(1).split(/\s+/)[0].toLowerCase()
        const s = cmdItems[Math.min(cmdSel, cmdItems.length - 1)]
        if (s && s.cmd !== typed) { e.preventDefault(); pickCmd(cmdSel); return }
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
    if (e.key === 'ArrowUp' && !cmdItems.length && !streaming && !input) {
      const users = items.filter((i) => i.kind === 'user' && !i.btw)
      if (users.length) { e.preventDefault(); setInput(users[users.length - 1].text); requestAnimationFrame(() => autosize()) }
    }
  }

  const stop = () => abortRef.current?.abort()

  // ---------- render ----------
  return (
    <div className={'view' + (visible ? ' active' : '')} id="chat-view">
      <div id="log-wrap">
        {items.length === 0 && (
          <motion.div id="welcome" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }}>
            <motion.div className="welcome-logo" animate={{ y: [0, -8, 0] }} transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}>⚡</motion.div>
            <h2>Server Hub</h2>
            <p>Your home server, on a leash. Ask anything, run workflows, branch chats, or poke the mascot.</p>
            <div className="chips">
              {CHIPS.map((ch) => (
                <motion.button key={ch.label} className="chip" whileHover={{ y: -2, scale: 1.03 }} whileTap={{ scale: 0.97 }}
                  onClick={() => send(ch.prompt)}>{ch.icon} {ch.label}</motion.button>
              ))}
            </div>
          </motion.div>
        )}
        <div id="log" ref={logRef} onScroll={onScroll}>
          <AnimatePresence initial={false}>
            {items.map((it) => <Item key={it.id} it={it} onEdit={editMsg} onRetry={retryMsg} />)}
          </AnimatePresence>
        </div>
        {showDown && <button id="scroll-down" onClick={() => { const el = logRef.current; el.scrollTop = el.scrollHeight }}>↓</button>}
      </div>
      <footer>
        {cmdItems.length > 0 && (
          <div id="cmd-menu">
            {cmdItems.map((s, i) => (
              <div key={s.cmd} className={'cmd-item' + (i === Math.min(cmdSel, cmdItems.length - 1) ? ' selected' : '')}
                onMouseDown={(e) => { e.preventDefault(); pickCmd(i) }} onMouseEnter={() => setCmdSel(i)}>
                <span className="c">{s.cmd}</span><span className="a">{s.args}</span><span className="d">{s.desc}</span>
              </div>
            ))}
          </div>
        )}
        {attach.length > 0 && (
          <div className="attach-row">
            {attach.map((a, i) => (
              <span key={i} className="attach-chip" title={a.path}>
                📎 {a.name}
                <button onClick={() => setAttach((x) => x.filter((_, j) => j !== i))}>×</button>
              </span>
            ))}
          </div>
        )}
        <div className="composer"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); if (e.dataTransfer.files?.length) addFiles([...e.dataTransfer.files]) }}>
          {role !== 'guest' && (
            <button className="comp-btn" title="Attach files (or drop / paste)" onClick={() => {
              const inp = document.createElement('input'); inp.type = 'file'; inp.multiple = true
              inp.onchange = () => { if (inp.files?.length) addFiles([...inp.files]) }
              inp.click()
            }}>📎</button>
          )}
          {SR && <button className={'comp-btn' + (mic ? ' mic-on' : '')} title={mic ? 'Stop dictation' : 'Dictate (voice input)'} onClick={toggleMic}>🎤</button>}
          <textarea id="input" ref={inputRef} rows={1} placeholder={mic ? '🎤 Listening…' : 'Message the hub… (/ for commands)'}
            value={input} onChange={(e) => { setInput(e.target.value); setCmdSel(0); requestAnimationFrame(() => autosize()) }}
            onKeyDown={onKey}
            onPaste={(e) => { const fl = [...(e.clipboardData?.files || [])]; if (fl.length) { e.preventDefault(); addFiles(fl) } }} />
          <motion.button className={'send' + (streaming ? ' stop' : '')} whileTap={{ scale: 0.9 }}
            onClick={() => (streaming ? stop() : send())}>{streaming ? '■' : '➤'}</motion.button>
        </div>
        <div className="composer-hint">Enter to send · Shift+Enter newline · / commands · ↑ recall last · drop/paste files to attach · Ctrl+K palette</div>
      </footer>
    </div>
  )
}

// ---------- message item ----------
const rise = { initial: { opacity: 0, y: 10, scale: 0.98 }, animate: { opacity: 1, y: 0, scale: 1 }, exit: { opacity: 0, scale: 0.96 }, transition: { duration: 0.22 } }

function Item({ it, onEdit, onRetry }) {
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)

  if (it.kind === 'typing') return (
    <motion.div {...rise} className="turn bot"><div className="avatar bot">⚡</div>
      <div className="msg typing-bub"><div className="typing"><i /><i /><i /></div></div></motion.div>
  )
  if (it.kind === 'err') return <motion.div {...rise} className="err">{it.text}</motion.div>
  if (it.kind === 'tool') return (
    <motion.div {...rise} className={'tool' + (it.done ? ' done' : '') + (expanded ? ' expanded' : '')} onClick={() => setExpanded(!expanded)}>
      <div className="tool-header">
        {!it.done && <span className="tool-spinner" />}
        {it.done && <span className="tool-check">✓</span>}
        <span>{it.name}</span><span className="tool-chevron">▶</span>
      </div>
      {expanded && <div className="tool-detail">{it.input || '(no arguments captured)'}</div>}
    </motion.div>
  )
  if (it.kind === 'pre') return (
    <motion.div {...rise} className="turn bot"><div className="avatar bot">⚡</div>
      <div className="bubble-col"><div className="msg"><pre className="sys-pre"><code>{it.text}</code></pre></div></div></motion.div>
  )
  if (it.kind === 'sys') return (
    <motion.div {...rise} className="turn bot"><div className="avatar bot">⚡</div>
      <div className="bubble-col">{it.md ? <Markdown text={it.text} /> : <div className="msg sys-text">{it.text}</div>}</div></motion.div>
  )

  const copy = () => { navigator.clipboard.writeText(it.text || '').catch(() => {}); setCopied(true); setTimeout(() => setCopied(false), 1400) }

  if (it.kind === 'user') return (
    <motion.div {...rise} className={'turn user' + (it.btw ? ' btw' : '')}>
      <div className="avatar user">S</div>
      <div className="bubble-col">
        {it.btw && <div className="btw-tag">btw · side question</div>}
        <div className="msg">{it.text}</div>
        <div className="msg-actions">
          {it.midx != null && <button className="msg-act" title="Edit & resend (rewinds the chat)" onClick={() => onEdit(it.midx, it.text)}>✏️ Edit</button>}
          <button className="msg-act" onClick={copy}>{copied ? '✓ Copied' : '📋'}</button>
        </div>
        <div className="msg-time">{fmtTime(it.ts)}</div>
      </div>
    </motion.div>
  )

  // bot
  return (
    <motion.div {...rise} className={'turn bot' + (it.btw ? ' btw' : '')}>
      <div className="avatar bot">⚡</div>
      <div className="bubble-col">
        {it.btw && <div className="btw-tag">btw · side answer</div>}
        <Markdown text={it.text} live={it.live} />
        <div className="msg-actions">
          <button className="msg-act" onClick={copy}>{copied ? '✓ Copied' : '📋 Copy'}</button>
          {it.midx != null && <button className="msg-act" title="Regenerate this answer" onClick={() => onRetry(it.midx)}>↻ Retry</button>}
        </div>
        <div className="msg-time">{fmtTime(it.ts)}</div>
      </div>
    </motion.div>
  )
}
