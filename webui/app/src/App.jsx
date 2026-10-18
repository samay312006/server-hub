import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { getJSON, postJSON, patchJSON, emit, on, fmtN, dpath } from './api.js'
import { THEMES, applyTheme, nextTheme } from './themes.js'
import Mascot from './Mascot.jsx'
import Chat from './Chat.jsx'
import Sidebar from './Sidebar.jsx'
import Dashboard from './Dashboard.jsx'
import Files from './Files.jsx'
import Devices from './Devices.jsx'
import Sessions from './Sessions.jsx'
import Terminal from './Terminal.jsx'
import Palette from './Palette.jsx'
import ParamsPanel from './ParamsPanel.jsx'
import { ConnectorsModal, WorkflowModal, ProjectModal, SkillsModal } from './Modals.jsx'

// Three.js scenes are heavy — load them after first paint.
const SceneCanvas = React.lazy(() => import('./three/SceneCanvas.jsx'))
const REDUCED_MOTION = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

export default function App() {
  const [authed, setAuthed] = useState(false)
  const [role, setRole] = useState('owner')
  const [models, setModels] = useState([])
  const [model, setModel] = useState('claude-opus-4-8')
  const [theme, setThemeId] = useState(localStorage.getItem('hub_theme') || 'midnight')
  const [mascot, setMascotId] = useState(localStorage.getItem('hub_mascot') || 'sparky')
  const [fx3d, setFx3dState] = useState(localStorage.getItem('hub_fx3d') !== 'off' && !REDUCED_MOTION)
  const [effort, setEffort] = useState('')
  const [usage, setUsage] = useState(null)
  const [params, setParams] = useState({ systemPrompt: '', permissionMode: '', turnTimeoutSec: 600 })
  const paramsRef = useRef(params)
  paramsRef.current = params

  const [convs, setConvs] = useState([])
  const [workflows, setWorkflows] = useState([])
  const [projects, setProjects] = useState([])
  const [devices, setDevices] = useState([])
  const [device, setDevice] = useState('') // '' = this (local) node; else a peer id
  const [activeConvId, setActiveConvId] = useState('')
  const [title, setTitle] = useState('Server Hub')
  const [tokens, setTokens] = useState({ in: 0, out: 0 })
  const [tab, setTab] = useState('chat')
  const [sbOpen, setSbOpen] = useState(false)
  const [paramsOpen, setParamsOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [modal, setModal] = useState('')
  const [toasts, setToasts] = useState([])
  const [waBanner, setWaBanner] = useState(false)
  const waDismissed = useRef(false)
  const [chatBusy, setChatBusy] = useState(false)

  useEffect(() => { applyTheme(theme) }, [theme])
  const setTheme = (id) => { setThemeId(id); emit('toast', { text: (THEMES[id]?.icon || '🎨') + ' ' + (THEMES[id]?.name || id) + ' theme', sub: THEMES[id]?.character ? `${THEMES[id].character} — ${THEMES[id].tagline}` : undefined }) }
  const setMascot = (id) => { setMascotId(id); localStorage.setItem('hub_mascot', id) }
  const setFx3d = (on) => { setFx3dState(on); localStorage.setItem('hub_fx3d', on ? 'on' : 'off') }
  const scene = fx3d
    ? <Suspense fallback={<div className="bg-blobs"><div className="blob b1" /><div className="blob b2" /></div>}><SceneCanvas theme={theme} /></Suspense>
    : <div className="bg-blobs"><div className="blob b1" /><div className="blob b2" /></div>

  // ---------- loaders ----------
  const loadConvs = useCallback(async () => { try { setConvs(await getJSON('/conversations')) } catch {} }, [])
  const loadWorkflows = useCallback(async () => { try { setWorkflows(await getJSON('/workflows')) } catch {} }, [])
  const loadProjects = useCallback(async () => {
    if (role === 'guest') return
    // Scope to the active device so the project list reflects the selected machine.
    try { setProjects(await getJSON(dpath('/projects', device))) } catch {}
  }, [role, device])
  const loadDevices = useCallback(async () => {
    if (role === 'guest') return
    try { const d = await getJSON('/devices'); setDevices(d.devices || []) } catch {}
  }, [role])
  const reload = { convs: loadConvs, workflows: loadWorkflows, projects: loadProjects }

  const loadConfig = useCallback(async () => {
    const cfg = await getJSON('/config')
    if (cfg.role) setRole(cfg.role)
    setModels(cfg.models || [])
    const m = (cfg.models || []).find((x) => x === cfg.model || x.includes(cfg.model))
    setModel(m || cfg.model)
    if (cfg.effort) setEffort(cfg.effort)
    return cfg
  }, [])

  const init = useCallback(async () => {
    setAuthed(true)
    try {
      await loadConfig()
      try { const p = await getJSON('/params'); setParams((d) => ({ ...d, ...p })) } catch {}
      await Promise.all([loadConvs(), loadWorkflows()])
    } catch {}
  }, [loadConfig, loadConvs, loadWorkflows])

  useEffect(() => { (async () => { try { const r = await fetch('/api/config'); if (r.ok) init() } catch {} })() }, [init])
  useEffect(() => { if (authed) loadProjects() }, [authed, role, loadProjects])
  useEffect(() => { if (authed && role !== 'guest') loadDevices() }, [authed, role, loadDevices])
  // Hot reload: keep projects + device online-status fresh while the app is open.
  useEffect(() => {
    if (!authed || role === 'guest') return
    const t = setInterval(() => { loadProjects(); loadDevices() }, 15000)
    return () => clearInterval(t)
  }, [authed, role, loadProjects, loadDevices])

  // ---------- live usage limits polling ----------
  useEffect(() => {
    if (!authed || role !== 'owner') return
    // keep showing the last good reading if a refresh fails (endpoint rate-limits)
    const load = async () => { try { const u = await getJSON('/usage'); if (u.ok) setUsage(u) } catch {} }
    load()
    const t = setInterval(load, 90000)
    return () => clearInterval(t)
  }, [authed, role])

  // ---------- WA banner polling ----------
  useEffect(() => {
    if (!authed) return
    const check = async () => {
      try {
        const s = await getJSON('/wa-status')
        if (s.needsQR && !waDismissed.current) setWaBanner(true)
        else if (s.ready) { setWaBanner(false); waDismissed.current = false }
      } catch {}
    }
    check()
    const t = setInterval(check, 30000)
    return () => clearInterval(t)
  }, [authed])

  // ---------- bus wiring ----------
  useEffect(() => on('convs-dirty', loadConvs), [loadConvs])
  useEffect(() => on('conv-active', ({ id }) => setActiveConvId(id)), [])
  useEffect(() => on('title', ({ title: t }) => setTitle(t)), [])
  useEffect(() => on('usage', (u) => setTokens((t) => ({ in: t.in + (u.input_tokens || 0), out: t.out + (u.output_tokens || 0) }))), [])
  useEffect(() => on('usage-reset', () => setTokens({ in: 0, out: 0 })), [])
  useEffect(() => on('switch-tab', ({ tab: t }) => setTab(t)), [])
  useEffect(() => on('toggle-params', () => setParamsOpen((o) => !o)), [])
  useEffect(() => on('cycle-theme', () => setThemeId((t) => nextTheme(t))), [])
  useEffect(() => on('logout', () => setAuthed(false)), [])
  useEffect(() => on('chat-streaming', ({ active }) => setChatBusy(active)), [])
  useEffect(() => on('toast', ({ text, sub }) => {
    const id = Math.random().toString(36).slice(2)
    setToasts((t) => [...t, { id, text, sub }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500)
  }), [])
  useEffect(() => on('set-model', ({ query }) => {
    setModels((ms) => {
      const want = (query || '').toLowerCase()
      const opt = want && ms.find((m) => m.toLowerCase().includes(want))
      if (opt) { changeModel(opt) } else emit('toast', { text: '🧠 Models: ' + ms.map(shortModel).join(', ') })
      return ms
    })
  }), [])
  useEffect(() => on('activate-project', async ({ id }) => {
    const p = projects.find((x) => x.id === id)
    if (!p) return
    await postJSON(`/projects/${id}/activate`)
    loadProjects()
    emit('toast', { text: '📁 ' + p.name + ' active — new chats run here', sub: p.workdir })
  }), [projects, loadProjects])

  // ---------- global keys ----------
  useEffect(() => {
    const h = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen((o) => !o) }
      else if (e.key === 'Escape') { setPaletteOpen(false); setParamsOpen(false); setModal('') }
    }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [])

  const changeModel = async (m) => {
    setModel(m)
    try { if (role === 'owner') await postJSON('/config', { model: m }) } catch {}
    emit('toast', { text: '🧠 Model: ' + shortModel(m) })
  }

  const changeEffort = async (lvl) => {
    setEffort(lvl)
    try { await postJSON('/config', { effort: lvl }) } catch {}
    emit('toast', { text: '🎚 Effort: ' + lvl, sub: 'Applies to newly started chat sessions' })
  }

  const PERM_LABELS = {
    bypassPermissions: { name: '⚡ Auto', sub: 'Runs everything without asking' },
    acceptEdits: { name: '✏️ Accept Edits', sub: 'Auto-applies file edits; asks for the rest' },
    plan: { name: '📋 Plan', sub: 'Researches & plans first, makes no changes' },
    default: { name: '🛡 Ask', sub: 'Prompts before tool use' },
  }
  const changePermMode = async (m) => {
    const next = { ...paramsRef.current, permissionMode: m }
    setParams(next)
    try { await postJSON('/params', next) } catch {}
    emit('toast', { text: (PERM_LABELS[m]?.name || m) + ' mode', sub: PERM_LABELS[m]?.sub })
  }

  const deviceName = (id) => {
    const dev = devices.find((x) => (id ? x.id === id : x.self))
    return dev?.name || 'this device'
  }
  const isLocalAgent = ['localhost', '127.0.0.1', '::1'].includes(location.hostname)

  // Console = in-browser terminal SSH'd into the active device (works everywhere).
  const openTerminal = (workdir) => {
    emit('open-terminal', { device, deviceName: deviceName(device), cwd: workdir || '' })
    emit('mood', { mood: 'happy', quip: 'Terminal away!' })
  }

  // VS Code = native desktop app launched on THIS (local) machine. For a peer it
  // opens via Remote-SSH into the target. Runs locally (no ?device proxy).
  const openApp = async (app, workdir) => {
    if (app === 'terminal') return openTerminal(workdir)
    try {
      const body = { app }
      if (workdir) body.workdir = workdir
      if (app === 'vscode' && device) body.targetDevice = device
      const r = await postJSON('/open', body)
      const d = await r.json()
      if (d.ok) {
        const where = app === 'vscode' && device ? ' on ' + deviceName(device) + ' (Remote-SSH)' : ''
        emit('toast', { text: app === 'vscode' ? '🧑‍💻 VS Code opening' + where : '📂 Explorer opening on the server', sub: workdir })
        emit('mood', { mood: 'happy', quip: 'Code time!' })
      } else emit('toast', { text: '❌ ' + (d.error || 'failed') })
    } catch { emit('toast', { text: '❌ Could not reach server' }) }
  }

  const renameChat = async () => {
    if (!activeConvId) return
    const t = prompt('Rename chat:', title)
    if (!t || !t.trim()) return
    await patchJSON('/conversations/' + activeConvId, { title: t.trim() })
    setTitle(t.trim())
    loadConvs()
  }

  const getParams = () => paramsRef.current
  const guest = role === 'guest'
  const selDevice = devices.find((d) => (device ? d.id === device : d.self))
  const targetOnline = device ? !!selDevice?.online : true
  const vscodeEnabled = isLocalAgent && targetOnline
  const vscodeTitle = !isLocalAgent
    ? 'Open the hub on this laptop (localhost) to use VS Code'
    : !targetOnline ? deviceName(device) + ' is offline' : 'Open VS Code (Remote-SSH into ' + deviceName(device) + ')'

  if (!authed) return <>{scene}<Login onAuthed={(r) => { setRole(r); init() }} /></>

  return (
    <div id="app" data-role={role}>
      {scene}

      <Sidebar role={role} convs={convs} workflows={workflows} projects={projects} activeConvId={activeConvId}
        open={sbOpen} onClose={() => setSbOpen(false)} reload={reload} openApp={openApp} openTerminal={openTerminal}
        vscodeEnabled={vscodeEnabled} vscodeTitle={vscodeTitle}
        onNewWorkflow={() => setModal('workflow')} onNewProject={() => setModal('project')} />

      <div id="main">
        <header>
          <button id="menu-btn" onClick={() => setSbOpen(true)}>☰</button>
          <span className="dot" />
          <h1 id="chat-title" onDoubleClick={renameChat} title="Double-click to rename">{title}{guest ? ' (guest)' : ''}</h1>
          {(tokens.in > 0 || tokens.out > 0) && <span id="token-counter">↑{fmtN(tokens.in)} ↓{fmtN(tokens.out)}</span>}
          <select id="model-select" value={model} onChange={(e) => changeModel(e.target.value)}>
            {models.map((m) => <option key={m} value={m}>{shortModel(m)}</option>)}
          </select>
          {!guest && effort && (
            <select id="effort-select" title="Model effort (thinking depth) — applies to new sessions"
              value={effort} onChange={(e) => changeEffort(e.target.value)}>
              {['low', 'medium', 'high', 'xhigh'].map((l) => <option key={l} value={l}>🎚 {l}</option>)}
            </select>
          )}
          {!guest && (
            <select id="perm-select" title="Permission mode for new turns" value={params.permissionMode || 'bypassPermissions'} onChange={(e) => changePermMode(e.target.value)}>
              <option value="bypassPermissions">⚡ Auto</option>
              <option value="acceptEdits">✏️ Accept Edits</option>
              <option value="plan">📋 Plan</option>
              <option value="default">🛡 Ask</option>
            </select>
          )}
          {!guest && devices.length > 1 && (
            <select id="device-select" title="Active device — scopes Projects, Files, Console & VS Code" value={device} onChange={(e) => setDevice(e.target.value)}>
              {devices.map((d) => <option key={d.id} value={d.self ? '' : d.id} disabled={!d.self && !d.online}>{d.online ? '🟢' : '⚪'} {d.name}{!d.self && !d.online ? ' (offline)' : ''}</option>)}
            </select>
          )}
          {!guest && usage && <UsagePill usage={usage} onClick={() => setTab('dashboard')} />}
          {!guest && <button className={'hbtn' + (vscodeEnabled ? '' : ' disabled')} disabled={!vscodeEnabled} title={vscodeTitle} onClick={() => openApp('vscode')}>{'</>'} Code</button>}
          {!guest && <button className="hbtn" title={'Open a console on ' + deviceName(device)} onClick={() => openApp('terminal')}>{'>_'} Console</button>}
          <button className={'hbtn' + (paramsOpen ? ' active' : '')} title="Chat parameters" onClick={() => setParamsOpen((o) => !o)}>⚙</button>
          <button className="hbtn" title="Cycle theme" onClick={() => setThemeId(nextTheme(theme))}>{THEMES[theme]?.icon || '🎨'}</button>
          {!guest && <button className="hbtn" onClick={() => setModal('skills')}>Skills</button>}
          {!guest && <button className="hbtn" onClick={() => setModal('connectors')}>Connectors</button>}
        </header>

        <AnimatePresence>
          {waBanner && (
            <motion.div className="wa-banner" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}>
              ⚠ WhatsApp needs QR scan — open <code>C:\server-hub\whatsapp-mcp\qr.png</code> and scan with WhatsApp → Linked Devices
              <button onClick={() => { setWaBanner(false); waDismissed.current = true }}>Dismiss</button>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="tab-bar">
          <div className={'tab' + (tab === 'chat' ? ' active' : '')} onClick={() => setTab('chat')}>
            💬 Chat{chatBusy && tab !== 'chat' && <span className="tab-busy-dot" title="Task running…" />}
          </div>
          {!guest && <div className={'tab' + (tab === 'files' ? ' active' : '')} onClick={() => setTab('files')}>📂 Files</div>}
          {!guest && <div className={'tab' + (tab === 'devices' ? ' active' : '')} onClick={() => setTab('devices')}>🖧 Devices</div>}
          {!guest && <div className={'tab' + (tab === 'sessions' ? ' active' : '')} onClick={() => setTab('sessions')}>🖥 Sessions</div>}
          {!guest && <div className={'tab' + (tab === 'dashboard' ? ' active' : '')} onClick={() => setTab('dashboard')}>📈 Dashboard</div>}
        </div>

        <TabErrorBoundary tab={tab}>
          <Chat role={role} model={model} getParams={getParams} visible={tab === 'chat'} activeProject={projects.find((p) => p.active) || null} />
          {!guest && <Files visible={tab === 'files'} device={device} />}
          {!guest && <Devices visible={tab === 'devices'} onPick={setDevice} />}
          {!guest && <Sessions visible={tab === 'sessions'} device={device} />}
          <Dashboard visible={tab === 'dashboard'} />
        </TabErrorBoundary>
      </div>

      <ParamsPanel open={paramsOpen} onClose={() => setParamsOpen(false)} params={params} setParams={setParams}
        theme={theme} setTheme={setTheme} mascot={mascot} setMascot={setMascot} fx3d={fx3d} setFx3d={setFx3d} />

      <Palette open={paletteOpen} onClose={() => setPaletteOpen(false)} role={role} convs={convs}
        workflows={workflows} projects={projects} openApp={openApp} setTheme={setTheme} setMascot={setMascot}
        openModal={setModal} />

      {modal === 'connectors' && <ConnectorsModal onClose={() => setModal('')} device={device} />}
      {modal === 'skills' && <SkillsModal onClose={() => setModal('')} device={device} />}
      {modal === 'workflow' && <WorkflowModal onClose={() => setModal('')} reload={reload} />}
      {modal === 'project' && <ProjectModal onClose={() => setModal('')} reload={reload} />}

      <Terminal />

      {mascot !== 'none' && <Mascot characterId={mascot} />}

      <div className="toasts">
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div key={t.id} className="toast" initial={{ opacity: 0, y: 16, scale: 0.95 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8 }}>
              <div>{t.text}</div>
              {t.sub && <div className="toast-sub">{t.sub}</div>}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  )
}

// Keeps one broken tab from blanking the whole app (e.g. a UI/server version
// mismatch). Resets automatically when you switch tabs.
class TabErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { err: null } }
  static getDerivedStateFromError(err) { return { err } }
  componentDidCatch(err) { console.error('[tab crash]', err) }
  componentDidUpdate(prev) { if (prev.tab !== this.props.tab && this.state.err) this.setState({ err: null }) }
  render() {
    if (this.state.err) return (
      <div className="view active" style={{ padding: 24, overflowY: 'auto' }}>
        <div className="dash-empty" style={{ maxWidth: 520, margin: '40px auto', textAlign: 'center' }}>
          <div style={{ fontSize: 32 }}>😵‍💫</div>
          <h3>This tab hit an error</h3>
          <p style={{ fontSize: 12.5, color: 'var(--muted)' }}>{String(this.state.err?.message || this.state.err)}</p>
          <p style={{ fontSize: 12.5, color: 'var(--muted)' }}>If you just updated the UI, restart the hub server (<code>pm2 restart hub-webui</code>) so the backend matches, then reload.</p>
          <button className="hbtn" onClick={() => location.reload()}>Reload</button>
        </div>
      </div>
    )
    return this.props.children
  }
}

function shortModel(m) { return String(m).replace(/^claude-/, '').replace(/-\d{4,}.*$/, '') }

function UsagePill({ usage, onClick }) {
  const five = usage.windows.find((w) => w.id === 'five_hour')
  const week = usage.windows.find((w) => w.id === 'seven_day') || usage.windows.find((w) => w.id.startsWith('seven_day'))
  const worst = Math.max(0, ...usage.windows.map((w) => w.pct))
  const cls = worst >= 85 ? 'crit' : worst >= 60 ? 'warn' : 'ok'
  const title = usage.windows.map((w) => `${w.label}: ${w.pct}%${w.resetsAt ? ' · resets in ' + untilStr(w.resetsAt) : ''}`).join('\n')
    + (usage.stale ? '\n(cached — live refresh rate-limited)' : '')
  return (
    <button className={'usage-pill ' + cls} title={title + '\nClick for details'} onClick={onClick}>
      {five && <span>5h {five.pct}%</span>}
      {five && week && <span className="usage-sep">·</span>}
      {week && <span>7d {week.pct}%</span>}
    </button>
  )
}

export function untilStr(iso) {
  const ms = new Date(iso).getTime() - Date.now()
  if (!isFinite(ms) || ms <= 0) return 'now'
  const m = Math.round(ms / 60000)
  if (m < 60) return m + 'm'
  const h = Math.floor(m / 60)
  if (h < 48) return h + 'h ' + (m % 60) + 'm'
  return Math.round(h / 24) + 'd'
}

function Login({ onAuthed }) {
  const [pw, setPw] = useState('')
  const [hint, setHint] = useState('')
  const tryLogin = async () => {
    try {
      const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }) })
      if (!r.ok) { setHint('Wrong password'); return }
      const d = await r.json()
      onAuthed(d.role || 'owner')
    } catch { setHint('Connection error') }
  }
  return (
    <div id="login">
      <motion.div className="login-logo" animate={{ y: [0, -8, 0], rotate: [0, 3, -3, 0] }} transition={{ duration: 4, repeat: Infinity }}>⚡</motion.div>
      <h2>Server Hub</h2>
      <input type="password" placeholder="Password" autoComplete="current-password" value={pw}
        onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') tryLogin() }} />
      <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.97 }} onClick={tryLogin}>Unlock</motion.button>
      <div className="hint">{hint}</div>
    </div>
  )
}
