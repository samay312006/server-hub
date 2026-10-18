import React, { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { getJSON, postJSON, delReq, dpath, emit } from './api.js'

function Overlay({ children, onClose }) {
  return (
    <div className="overlay" onClick={(e) => { if (e.target.classList.contains('overlay')) onClose() }}>
      <motion.div className="modal" initial={{ opacity: 0, scale: 0.96, y: -8 }} animate={{ opacity: 1, scale: 1, y: 0 }}>
        {children}
      </motion.div>
    </div>
  )
}

// A few one-click MCP connector presets (command + args prefilled).
const CONNECTOR_PRESETS = {
  'playwright': { type: 'stdio', cmd: 'npx', args: '["-y","@playwright/mcp@latest","--headless","--isolated"]' },
  'filesystem': { type: 'stdio', cmd: 'npx', args: '["-y","@modelcontextprotocol/server-filesystem","C:\\\\server-hub"]' },
  'fetch': { type: 'stdio', cmd: 'npx', args: '["-y","@modelcontextprotocol/server-fetch"]' },
}

export function ConnectorsModal({ onClose, device = '' }) {
  const [cns, setCns] = useState({})
  const [f, setF] = useState({ name: '', type: 'stdio', cmd: '', args: '' })
  const load = async () => { try { setCns(await getJSON(dpath('/connectors', device))) } catch {} }
  useEffect(() => { load() }, [device]) // eslint-disable-line

  const usePreset = (name) => { const p = CONNECTOR_PRESETS[name]; if (p) setF({ name, type: p.type, cmd: p.cmd, args: p.args }) }
  const add = async () => {
    let args = []
    try { args = JSON.parse(f.args || '[]') } catch { emit('toast', { text: '⚠️ Args must be a JSON array' }); return }
    if (!f.name || !f.cmd) { emit('toast', { text: '⚠️ Name and command required' }); return }
    await postJSON(dpath('/connectors', device), { name: f.name, config: { type: f.type || 'stdio', command: f.cmd, args } })
    setF({ name: '', type: 'stdio', cmd: '', args: '' })
    load()
  }
  const remove = async (name) => {
    if (!confirm(`Remove connector "${name}"? This edits ~/.claude.json.`)) return
    await delReq(dpath('/connectors/' + encodeURIComponent(name), device))
    load()
  }

  return (
    <Overlay onClose={onClose}>
      <h3>MCP Connectors <button className="mclose" onClick={onClose}>×</button></h3>
      {!Object.keys(cns).length && <div className="dash-empty">No connectors yet.</div>}
      {Object.entries(cns).map(([name, cfg]) => (
        <div className="cn-card" key={name}>
          <div className="cn-name">{name}</div>
          <div className="cn-sub">{cfg.command || ''} {(cfg.args || []).join(' ')}</div>
          <div className="cn-actions"><button className="btn-danger" onClick={() => remove(name)}>Remove</button></div>
        </div>
      ))}
      <details>
        <summary>Add connector</summary>
        <label className="flabel">Presets</label>
        <div className="preset-row">
          {Object.keys(CONNECTOR_PRESETS).map((p) => <button key={p} className="mini" onClick={() => usePreset(p)}>{p}</button>)}
        </div>
        <label className="flabel">Name</label>
        <input className="finput" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="my-server" />
        <label className="flabel">Type</label>
        <input className="finput" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })} placeholder="stdio" />
        <label className="flabel">Command</label>
        <input className="finput" value={f.cmd} onChange={(e) => setF({ ...f, cmd: e.target.value })} placeholder="node" />
        <label className="flabel">Args (JSON array)</label>
        <input className="finput" value={f.args} onChange={(e) => setF({ ...f, args: e.target.value })} placeholder='["path/to/server.js"]' />
        <button className="btn-primary" onClick={add}>Add Connector</button>
      </details>
    </Overlay>
  )
}

export function WorkflowModal({ onClose, reload }) {
  const [f, setF] = useState({ name: '', desc: '', prompt: '', schedType: '', every: 60, daily: '09:00' })
  const save = async () => {
    if (!f.name || !f.prompt) { emit('toast', { text: '⚠️ Name and prompt required' }); return }
    const schedule = f.schedType === 'every' ? { type: 'every', minutes: Math.max(5, parseInt(f.every, 10) || 60) }
      : f.schedType === 'daily' ? { type: 'daily', time: f.daily }
      : null
    await postJSON('/workflows', { name: f.name, prompt: f.prompt, description: f.desc, schedule })
    reload.workflows()
    if (schedule) emit('toast', { text: '⏰ Scheduled: ' + f.name, sub: schedule.type === 'daily' ? 'daily at ' + schedule.time : 'every ' + schedule.minutes + ' min' })
    onClose()
  }
  return (
    <Overlay onClose={onClose}>
      <h3>New Workflow <button className="mclose" onClick={onClose}>×</button></h3>
      <label className="flabel">Name</label>
      <input className="finput" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Daily summary" />
      <label className="flabel">Description (optional)</label>
      <input className="finput" value={f.desc} onChange={(e) => setF({ ...f, desc: e.target.value })} />
      <label className="flabel">Prompt</label>
      <textarea className="finput" value={f.prompt} onChange={(e) => setF({ ...f, prompt: e.target.value })}
        placeholder="Check server logs and send me a summary…" />
      <label className="flabel">Schedule (optional — runs automatically, result lands in Conversations)</label>
      <div className="sched-row">
        <select className="finput" style={{ flex: 1 }} value={f.schedType} onChange={(e) => setF({ ...f, schedType: e.target.value })}>
          <option value="">Manual only</option>
          <option value="daily">Daily at…</option>
          <option value="every">Every N minutes</option>
        </select>
        {f.schedType === 'daily' && <input className="finput" type="time" style={{ flex: 1 }} value={f.daily} onChange={(e) => setF({ ...f, daily: e.target.value })} />}
        {f.schedType === 'every' && <input className="finput" type="number" min="5" step="5" style={{ flex: 1 }} value={f.every} onChange={(e) => setF({ ...f, every: e.target.value })} />}
      </div>
      <button className="btn-primary" onClick={save}>Save</button>
    </Overlay>
  )
}

export function SkillsModal({ onClose, device = '' }) {
  const [skills, setSkills] = useState([])
  const [f, setF] = useState({ name: '', description: '', body: '' })
  const load = async () => { try { const d = await getJSON(dpath('/skills', device)); setSkills(d.skills || []) } catch {} }
  useEffect(() => { load() }, [device]) // eslint-disable-line

  const save = async () => {
    if (!f.name.trim()) { emit('toast', { text: '⚠️ Name required' }); return }
    const r = await (await postJSON(dpath('/skills', device), f)).json()
    if (r.ok) { emit('toast', { text: '🧩 Skill saved: ' + r.slug }); setF({ name: '', description: '', body: '' }); load() }
    else emit('toast', { text: '❌ ' + (r.error || 'failed') })
  }
  const edit = async (slug) => {
    try {
      const d = await getJSON(dpath('/skills/' + encodeURIComponent(slug), device))
      const m = (d.content || '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
      const fm = m ? m[1] : '', body = m ? m[2].trim() : (d.content || '')
      setF({ name: (fm.match(/name:\s*(.+)/) || [])[1] || slug, description: (fm.match(/description:\s*(.+)/) || [])[1] || '', body })
    } catch {}
  }
  const remove = async (slug) => {
    if (!confirm(`Delete skill "${slug}"?`)) return
    await delReq(dpath('/skills/' + encodeURIComponent(slug), device))
    load()
  }

  return (
    <Overlay onClose={onClose}>
      <h3>🧩 Skills <button className="mclose" onClick={onClose}>×</button></h3>
      <div className="dash-empty" style={{ fontSize: 11.5, marginBottom: 6 }}>Saved to ~/.claude/skills on the active device. Claude auto-discovers them.</div>
      {!skills.length && <div className="dash-empty">No skills yet.</div>}
      {skills.map((s) => (
        <div className="cn-card" key={s.scope + s.slug}>
          <div className="cn-name">{s.name} <span className="skill-scope">{s.scope}</span></div>
          <div className="cn-sub">{s.description || s.slug}</div>
          <div className="cn-actions">
            <button className="mini" onClick={() => edit(s.slug)}>Edit</button>
            {s.scope === 'user' && <button className="btn-danger" onClick={() => remove(s.slug)}>Delete</button>}
          </div>
        </div>
      ))}
      <details>
        <summary>New / edit skill</summary>
        <label className="flabel">Name</label>
        <input className="finput" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="pdf-extractor" />
        <label className="flabel">Description (when Claude should use it)</label>
        <input className="finput" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="Use when the user wants to pull text from a PDF" />
        <label className="flabel">Instructions (Markdown body of SKILL.md)</label>
        <textarea className="finput" rows={6} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} placeholder="# How to do X&#10;Step-by-step instructions Claude should follow…" />
        <button className="btn-primary" onClick={save}>Save Skill</button>
      </details>
    </Overlay>
  )
}

export function ProjectModal({ onClose, reload }) {
  const [f, setF] = useState({ name: '', workdir: '', desc: '', template: '' })
  const save = async () => {
    if (!f.name || !f.workdir) { emit('toast', { text: '⚠️ Name and workdir required' }); return }
    const r = await (await postJSON('/projects', { name: f.name, workdir: f.workdir, description: f.desc, template: f.template || undefined })).json()
    if (r.error) { emit('toast', { text: '❌ ' + r.error }); return }
    if (f.template) emit('toast', { text: '🏗 Scaffolded ' + f.template + ' project', sub: f.workdir })
    reload.projects()
    onClose()
  }
  return (
    <Overlay onClose={onClose}>
      <h3>New Project <button className="mclose" onClick={onClose}>×</button></h3>
      <label className="flabel">Name</label>
      <input className="finput" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="my-project" />
      <label className="flabel">Working Directory</label>
      <input className="finput" value={f.workdir} onChange={(e) => setF({ ...f, workdir: e.target.value })} placeholder="C:\my-project" />
      <label className="flabel">Template (used only if the folder doesn't exist yet — scaffolds files + git init)</label>
      <select className="finput" value={f.template} onChange={(e) => setF({ ...f, template: e.target.value })}>
        <option value="">None — existing folder</option>
        <option value="empty">Empty (README + git)</option>
        <option value="node">Node.js service</option>
        <option value="vite-react">Vite + React app</option>
        <option value="python">Python script</option>
      </select>
      <label className="flabel">Description (optional)</label>
      <input className="finput" value={f.desc} onChange={(e) => setF({ ...f, desc: e.target.value })} />
      <button className="btn-primary" onClick={save}>Save</button>
    </Overlay>
  )
}
