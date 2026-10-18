import React, { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { getJSON, postJSON, dpath, emit } from './api.js'
import Markdown from './Markdown.jsx'

const TASK_MODELS = [['claude-haiku-4-5-20251001', 'haiku'], ['claude-sonnet-4-6', 'sonnet'], ['claude-opus-4-8', 'opus']]

const ago = (ms) => {
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 60) return Math.round(s) + 's'
  if (s < 3600) return Math.round(s / 60) + 'm'
  if (s < 86400) return Math.round(s / 3600) + 'h'
  return Math.round(s / 86400) + 'd'
}
const base = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p

export default function Sessions({ visible, device = '' }) {
  const [sessions, setSessions] = useState([])
  const [sel, setSel] = useState('')
  const [events, setEvents] = useState([])
  const [live, setLive] = useState(false)
  const [composer, setComposer] = useState(false)
  const [tprompt, setTprompt] = useState('')
  const [tmodel, setTmodel] = useState('claude-sonnet-4-6')
  const esRef = useRef(null)
  const logRef = useRef(null)
  const atBottom = useRef(true)

  const [unavailable, setUnavailable] = useState(false)
  const loadList = useCallback(async () => {
    try { const d = await getJSON(dpath('/sessions', device)); setSessions(d.sessions || []); setUnavailable(false) }
    catch { setSessions([]); setUnavailable(true) }
  }, [device])

  // refresh the list while the tab is open; switching device resets selection
  useEffect(() => { if (visible) { loadList(); const t = setInterval(loadList, 15000); return () => clearInterval(t) } }, [visible, loadList])
  useEffect(() => { setSel(''); setEvents([]) }, [device])

  // open / close the live SSE stream for the selected session
  useEffect(() => {
    if (esRef.current) { esRef.current.close(); esRef.current = null }
    setEvents([]); setLive(false)
    if (!sel || !visible) return
    const es = new EventSource('/api' + dpath('/sessions/' + sel + '/stream', device))
    esRef.current = es
    setLive(true)
    es.onmessage = (e) => {
      let ev; try { ev = JSON.parse(e.data) } catch { return }
      setEvents((prev) => (prev.length > 1200 ? [...prev.slice(-1000), ev] : [...prev, ev]))
    }
    es.onerror = () => setLive(false)
    return () => { es.close(); esRef.current = null }
  }, [sel, device, visible])

  // stick to bottom unless the user scrolls up
  useEffect(() => {
    const el = logRef.current
    if (el && atBottom.current) el.scrollTop = el.scrollHeight
  }, [events])
  const onScroll = () => { const el = logRef.current; if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60 }

  // start a headless Claude task on the active device, then watch it stream live
  const runTask = async () => {
    if (!tprompt.trim()) return
    try {
      const r = await (await postJSON(dpath('/tasks', device), { prompt: tprompt.trim(), model: tmodel })).json()
      if (r.ok) { emit('toast', { text: '⚙ Task started — watching live' }); setTprompt(''); setComposer(false); setSel(r.sessionId); setTimeout(loadList, 1500) }
      else emit('toast', { text: '❌ ' + (r.error || 'failed') })
    } catch { emit('toast', { text: '❌ task failed' }) }
  }

  if (!visible) return null
  const active = sessions.filter((s) => s.status === 'active')
  const idle = sessions.filter((s) => s.status !== 'active')

  return (
    <div className="view active" id="sessions-view">
      <div className="sess-cols">
        <div className="sess-list">
          <div className="sess-list-h">
            🖥 Claude sessions
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
              <button className="mini" onClick={() => setComposer((v) => !v)} title="Run a task on this device">▶ Task</button>
              <button className="mini" onClick={loadList} title="Refresh">↻</button>
            </span>
          </div>
          {composer && (
            <div className="task-composer">
              <textarea value={tprompt} onChange={(e) => setTprompt(e.target.value)} rows={3} placeholder="Tell Claude what to do on this device…" />
              <div className="task-composer-row">
                <select value={tmodel} onChange={(e) => setTmodel(e.target.value)}>
                  {TASK_MODELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
                <button className="mini commit-btn" onClick={runTask} disabled={!tprompt.trim()}>Run ▶</button>
              </div>
            </div>
          )}
          {unavailable && <div className="dash-empty">Live sessions need the updated hub server. Restart it (<code>pm2 restart hub-webui</code>) and reload.</div>}
          {!unavailable && sessions.length === 0 && <div className="dash-empty">No Claude sessions found on this device yet.</div>}
          {active.length > 0 && <div className="sess-group">● Active</div>}
          {active.map((s) => <SessRow key={s.sessionId} s={s} sel={sel} onPick={setSel} />)}
          {idle.length > 0 && <div className="sess-group">Recent</div>}
          {idle.map((s) => <SessRow key={s.sessionId} s={s} sel={sel} onPick={setSel} />)}
        </div>

        <div className="sess-mirror">
          {!sel ? (
            <div className="dash-empty" style={{ margin: 'auto' }}>Select a session to watch its console live.</div>
          ) : (
            <>
              <div className="sess-mirror-h">
                <span className={'sess-dot ' + (live ? 'on' : 'off')} />
                <span className="file-name">{base(sessions.find((s) => s.sessionId === sel)?.cwd) || sel.slice(0, 8)}</span>
                <span className="sess-live">{live ? 'LIVE' : 'ended'}</span>
              </div>
              <div className="sess-log" ref={logRef} onScroll={onScroll}>
                {events.length === 0 && <div className="dash-empty">Waiting for output…</div>}
                {events.map((e, i) => <EventBlock key={i} e={e} />)}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function SessRow({ s, sel, onPick }) {
  return (
    <motion.div className={'sess-row' + (sel === s.sessionId ? ' active' : '')} onClick={() => onPick(s.sessionId)}
      initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
      <span className={'sess-dot ' + (s.status === 'active' ? 'on' : 'off')} />
      <div className="sess-row-body">
        <div className="sess-row-top"><span className="sess-cwd">{base(s.cwd)}</span><span className="sess-when">{ago(s.lastActivity)}</span></div>
        <div className="sess-row-prompt">{s.lastPrompt || s.sessionId.slice(0, 8)}</div>
      </div>
    </motion.div>
  )
}

function EventBlock({ e }) {
  if (e.kind === 'user') return <div className="ev ev-user"><span className="ev-tag">prompt</span><div className="ev-text">{e.text}</div></div>
  if (e.kind === 'assistant') return <div className="ev ev-asst"><Markdown text={e.text} /></div>
  if (e.kind === 'thinking') return <div className="ev ev-think">💭 {e.text}</div>
  if (e.kind === 'tool') return <div className="ev ev-tool">🔧 <b>{e.tool}</b>{e.input ? <span className="ev-tool-in"> · {e.input}</span> : ''}</div>
  if (e.kind === 'tool-result') return <details className="ev ev-result"><summary>↳ result</summary><pre>{e.text}</pre></details>
  return null
}
