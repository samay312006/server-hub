import React, { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { emit, delReq, postJSON } from './api.js'

export default function Sidebar({ role, convs, workflows, projects, activeConvId, open, onClose, onNewWorkflow, onNewProject, reload, openApp, openTerminal, vscodeEnabled, vscodeTitle }) {
  const [q, setQ] = useState('')
  const guest = role === 'guest'
  const filtered = q ? convs.filter((c) => (c.title || '').toLowerCase().includes(q.toLowerCase())) : convs

  const delConv = async (id) => {
    await delReq('/conversations/' + id)
    if (activeConvId === id) emit('newChat')
    reload.convs()
  }
  const activateProject = async (p) => {
    await postJSON(`/projects/${p.id}/activate`)
    reload.projects()

    // Find the most recent conversation already tied to this project's workdir.
    const normDir = (d) => (d || '').replace(/[\\/]+$/, '').toLowerCase()
    const projConvs = convs.filter((c) => normDir(c.workdir) === normDir(p.workdir))

    if (projConvs.length > 0) {
      // Open the most recent project conversation.
      emit('openConv', { id: projConvs[0].id })
      emit('toast', { text: '📁 ' + p.name, sub: projConvs.length + ' chat' + (projConvs.length > 1 ? 's' : '') + ' · opened most recent' })
    } else {
      // No existing convs for this project — clear the chat so the next message
      // creates a new one in the project workdir (with project context injected).
      emit('newChat')
      emit('toast', { text: '📁 ' + p.name + ' — new project chat', sub: p.workdir })
    }
    onClose()
  }

  // Group conversations by the folder they were created in.
  const baseName = (w) => (w ? w.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : 'General')
  const convGroups = {}
  for (const c of filtered) { const k = c.workdir || ''; (convGroups[k] = convGroups[k] || []).push(c) }
  const groupKeys = Object.keys(convGroups).sort((a, b) =>
    Math.max(...convGroups[b].map((c) => +new Date(c.updatedAt || 0))) - Math.max(...convGroups[a].map((c) => +new Date(c.updatedAt || 0))))
  const showHeaders = groupKeys.length > 1

  return (
    <>
      <div id="sb-overlay" className={open ? 'open' : ''} onClick={onClose} />
      <div id="sidebar" className={open ? 'open' : ''}>
        <div className="sb-logo">
          <motion.div className="logo-mark" whileHover={{ rotate: 10, scale: 1.08 }}>⚡</motion.div>
          <div className="logo-text">Server Hub</div>
        </div>
        <div className="sb-top">
          <motion.button className="new-btn" whileHover={{ y: -1 }} whileTap={{ scale: 0.98 }} onClick={() => { emit('newChat'); onClose() }}>
            <span>＋</span> New Chat
          </motion.button>
        </div>
        <div className="sb-search-wrap">
          <input id="sb-search" placeholder="Search conversations…" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
        </div>
        <div className="sb-scroll">
          <div className="sb-section">
            <div className="sb-title">Conversations</div>
            {filtered.length === 0 && <div className="sb-empty">No conversations yet.</div>}
            {groupKeys.map((k) => (
              <div key={k || 'general'} className="sb-conv-group">
                {showHeaders && <div className="sb-group-h" title={k || 'Chats not tied to a folder'}>📁 {baseName(k)}</div>}
                <ul className="sb-list">
                  <AnimatePresence initial={false}>
                    {convGroups[k].map((c) => (
                      <motion.li key={c.id} layout initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, height: 0 }}
                        className={'sb-item' + (c.id === activeConvId ? ' active' : '')}
                        onClick={() => { emit('openConv', { id: c.id }); onClose() }}>
                        <span>{c.title || 'Untitled'}</span>
                        <button className="x" title="Delete" onClick={(e) => { e.stopPropagation(); delConv(c.id) }}>×</button>
                      </motion.li>
                    ))}
                  </AnimatePresence>
                </ul>
              </div>
            ))}
          </div>
          <div className="sb-section">
            <div className="sb-title">Workflows {!guest && <button title="New workflow" onClick={onNewWorkflow}>+</button>}</div>
            <ul className="sb-list">
              {workflows.map((wf) => (
                <li key={wf.id} className="sb-item" title={wf.description || wf.prompt.slice(0, 80)}
                  onClick={() => { emit('sendPrompt', { text: wf.prompt }); emit('switch-tab', { tab: 'chat' }); onClose() }}>
                  <span>▶ {wf.name}</span>
                  {!guest && <button className="x" title="Delete" onClick={async (e) => { e.stopPropagation(); await delReq('/workflows/' + wf.id); reload.workflows() }}>×</button>}
                </li>
              ))}
            </ul>
          </div>
          {!guest && (
            <div className="sb-section">
              <div className="sb-title">Projects <button title="New project" onClick={onNewProject}>+</button></div>
              <ul className="sb-list">
                {projects.map((p) => (
                  <li key={p.id} className={'sb-item proj' + (p.active ? ' active' : '')}
                    title={p.workdir + (p.auto ? ' (auto-discovered from Claude Code)' : '')}
                    onClick={() => activateProject(p)}>
                    <span>{p.auto ? '📁 ' : ''}{p.name}</span>
                    <span className="proj-acts">
                      <button className={'mini' + (vscodeEnabled ? '' : ' disabled')} disabled={!vscodeEnabled} title={vscodeTitle || 'Open in VS Code'} onClick={(e) => { e.stopPropagation(); openApp('vscode', p.workdir) }}>{'</>'}</button>
                      <button className="mini" title="Open console here" onClick={(e) => { e.stopPropagation(); openTerminal(p.workdir) }}>{'>_'}</button>
                    </span>
                    {p.id !== 'default' && (
                      <button className="x" title={p.auto ? 'Hide' : 'Delete'}
                        onClick={async (e) => { e.stopPropagation(); await delReq('/projects/' + p.id); reload.projects() }}>×</button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <div className="sb-foot"><span className="kbd">Ctrl</span><span className="kbd">K</span> command palette</div>
      </div>
    </>
  )
}
