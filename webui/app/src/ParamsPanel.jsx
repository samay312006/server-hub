import React, { useState } from 'react'
import { THEMES } from './themes.js'
import { characterIds, characterLabel } from './Mascot.jsx'
import { postJSON } from './api.js'

export default function ParamsPanel({ open, onClose, params, setParams, theme, setTheme, mascot, setMascot, fx3d, setFx3d }) {
  const [saved, setSaved] = useState(false)
  const set = (k, v) => setParams((p) => ({ ...p, [k]: v }))

  const save = async () => {
    await postJSON('/params', params)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }
  const reset = () => {
    const d = { systemPrompt: '', permissionMode: '', turnTimeoutSec: 600, temperature: 1, maxTokens: 8192 }
    setParams(d)
    postJSON('/params', d)
  }

  return (
    <div id="params-panel" className={open ? 'open' : ''}>
      <h3>Chat Parameters <button className="mclose" onClick={onClose}>×</button></h3>

      <div className="param-group">
        <label className="param-label">Theme</label>
        <div className="theme-row">
          {Object.entries(THEMES).map(([id, t]) => (
            <button key={id} className={'theme-pill' + (theme === id ? ' on' : '')} onClick={() => setTheme(id)}
              title={t.character ? `${t.name} — with ${t.character}` : t.name}>
              {t.icon}<span>{t.name}</span>
            </button>
          ))}
        </div>
        <div className="param-hint">{THEMES[theme]?.character ? `Starring ${THEMES[theme].character} — ${THEMES[theme].tagline}` : ''}</div>
      </div>
      <div className="param-group">
        <label className="param-label">3D Scene</label>
        <div className="theme-row">
          <button className={'theme-pill' + (fx3d ? ' on' : '')} onClick={() => setFx3d(true)}>✨ Animated 3D</button>
          <button className={'theme-pill' + (!fx3d ? ' on' : '')} onClick={() => setFx3d(false)}>🪶 Lightweight</button>
        </div>
        <div className="param-hint">3D backgrounds use WebGL — switch to Lightweight on weak devices.</div>
      </div>
      <div className="param-group">
        <label className="param-label">Desktop Notifications</label>
        <div className="theme-row">
          <button className="theme-pill" onClick={async () => {
            if (!('Notification' in window)) return
            const perm = await Notification.requestPermission()
            if (perm === 'granted') new Notification('⚡ Server Hub', { body: 'Notifications enabled — you\'ll get pinged when long turns finish in the background.' })
          }}>
            {typeof Notification !== 'undefined' && Notification.permission === 'granted' ? '🔔 Enabled' : '🔕 Enable alerts'}
          </button>
        </div>
        <div className="param-hint">Pings you when a turn finishes while the tab is in the background.</div>
      </div>
      <div className="param-group">
        <label className="param-label">Mascot</label>
        <div className="theme-row">
          {characterIds.map((id) => (
            <button key={id} className={'theme-pill' + (mascot === id ? ' on' : '')} onClick={() => setMascot(id)}>
              {characterLabel(id)}
            </button>
          ))}
          <button className={'theme-pill' + (mascot === 'none' ? ' on' : '')} onClick={() => setMascot('none')}>🚫 None</button>
        </div>
      </div>
      <hr className="param-divider" />

      <div className="param-group">
        <label className="param-label">System Prompt</label>
        <textarea className="param-input" value={params.systemPrompt || ''} onChange={(e) => set('systemPrompt', e.target.value)}
          placeholder="You are a helpful assistant…" />
        <div className="param-hint">Injected as system context for this session.</div>
      </div>
      <div className="param-group">
        <label className="param-label">Permission Mode</label>
        <select className="param-select" value={params.permissionMode || ''} onChange={(e) => set('permissionMode', e.target.value)}>
          <option value="">Server default</option>
          <option value="bypassPermissions">⚡ Auto (bypassPermissions)</option>
          <option value="acceptEdits">✏️ Accept Edits</option>
          <option value="plan">📋 Plan</option>
          <option value="default">🛡 Ask (default)</option>
        </select>
        <div className="param-hint">Plan = research &amp; propose only (no changes). Accept Edits = auto-apply edits. Auto = run everything. Ask = prompt per tool. Also switchable from the header.</div>
      </div>
      <div className="param-group">
        <label className="param-label">Turn Timeout (seconds)</label>
        <input className="param-input" type="number" min="30" max="3600" step="30"
          value={params.turnTimeoutSec || 600} onChange={(e) => set('turnTimeoutSec', parseInt(e.target.value || '600', 10))} />
      </div>
      <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 10 }}>
        <button className="btn-primary" style={{ margin: 0 }} onClick={save}>Save</button>
        {saved && <span className="param-save-indicator show">✓ Saved</span>}
      </div>
      <div style={{ marginTop: 10 }}>
        <button className="link-btn" onClick={reset}>Reset to defaults</button>
      </div>
    </div>
  )
}
