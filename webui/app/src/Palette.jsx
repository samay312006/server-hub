import React, { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { emit } from './api.js'
import { THEMES } from './themes.js'
import { characterIds, characterLabel } from './Mascot.jsx'

export default function Palette({ open, onClose, role, convs, workflows, projects, openApp, setTheme, setMascot, openModal }) {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const inputRef = useRef(null)
  const listRef = useRef(null)

  useEffect(() => { if (open) { setQ(''); setSel(0); setTimeout(() => inputRef.current?.focus(), 30) } }, [open])

  const guest = role === 'guest'
  const items = []
  const add = (icon, label, cat, run) => items.push({ icon, label, cat, run })

  add('➕', 'New chat', 'action', () => emit('newChat'))
  add('💬', 'Open chat', 'action', () => emit('switch-tab', { tab: 'chat' }))
  if (!guest) add('📊', 'Open dashboard', 'action', () => emit('switch-tab', { tab: 'dashboard' }))
  add('⚙️', 'Chat parameters', 'action', () => emit('toggle-params'))
  add('💾', 'Export chat as Markdown', 'action', () => emit('export'))
  if (!guest) {
    add('🧑‍💻', 'Open VS Code (active project)', 'open', () => openApp('vscode'))
    add('⌨️', 'Open console (active project)', 'open', () => openApp('terminal'))
    add('📂', 'Open File Explorer (active project)', 'open', () => openApp('explorer'))
    add('🔌', 'Connectors', 'action', () => openModal('connectors'))
  }
  for (const [id, t] of Object.entries(THEMES)) add(t.icon, 'Theme: ' + t.name, 'theme', () => setTheme(id))
  for (const id of characterIds) add('🎭', 'Mascot: ' + characterLabel(id), 'mascot', () => setMascot(id))
  for (const w of workflows) add('▶️', w.name, 'workflow', () => { emit('switch-tab', { tab: 'chat' }); emit('sendPrompt', { text: w.prompt }) })
  if (!guest) for (const p of projects) add('📁', 'Switch to ' + p.name, 'project', () => emit('activate-project', { id: p.id }))
  for (const c of convs.slice(0, 25)) add('💬', c.title || 'Untitled', 'chat', () => emit('openConv', { id: c.id }))

  const ql = q.toLowerCase()
  const filtered = (ql ? items.filter((i) => i.label.toLowerCase().includes(ql)) : items).slice(0, 30)
  const selIdx = Math.min(sel, Math.max(filtered.length - 1, 0))

  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, filtered.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); const it = filtered[selIdx]; if (it) { onClose(); it.run() } }
    else if (e.key === 'Escape') onClose()
  }

  useEffect(() => {
    listRef.current?.children[selIdx]?.scrollIntoView({ block: 'nearest' })
  }, [selIdx])

  return (
    <AnimatePresence>
      {open && (
        <div id="palette-overlay" className="open" onClick={(e) => { if (e.target.id === 'palette-overlay') onClose() }}>
          <motion.div id="palette" initial={{ opacity: 0, scale: 0.96, y: -10 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.97 }}>
            <input id="palette-input" ref={inputRef} placeholder="Type a command or search…" autoComplete="off"
              value={q} onChange={(e) => { setQ(e.target.value); setSel(0) }} onKeyDown={onKey} />
            <div id="palette-list" ref={listRef}>
              {!filtered.length && <div className="pal-empty">No matches</div>}
              {filtered.map((it, i) => (
                <div key={it.cat + it.label} className={'pal-item' + (i === selIdx ? ' selected' : '')}
                  onMouseDown={(e) => { e.preventDefault(); onClose(); it.run() }} onMouseEnter={() => setSel(i)}>
                  <div className="pal-icon">{it.icon}</div>
                  <div className="pal-label">{it.label}</div>
                  <div className="pal-cat">{it.cat}</div>
                </div>
              ))}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  )
}
