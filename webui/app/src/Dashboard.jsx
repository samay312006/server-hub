import React, { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { getJSON, fmtN } from './api.js'
import { untilStr } from './App.jsx'

const card = { initial: { opacity: 0, y: 16 }, animate: { opacity: 1, y: 0 } }

export default function Dashboard({ visible }) {
  const [data, setData] = useState(null)
  const [usage, setUsage] = useState(null)
  const [updated, setUpdated] = useState('')

  const [analytics, setAnalytics] = useState(null)

  const refresh = async () => {
    try { setData(await getJSON('/dashboard')); setUpdated(new Date().toLocaleTimeString()) } catch {}
    try { const u = await getJSON('/usage'); setUsage((prev) => (u.ok ? u : (prev?.ok ? prev : u))) } catch {}
    try { setAnalytics(await getJSON('/analytics')) } catch {}
  }
  useEffect(() => {
    if (!visible) return
    refresh()
    const t = setInterval(refresh, 10000)
    return () => clearInterval(t)
  }, [visible])

  if (!visible) return null
  const tasks = Object.values(data?.tasks || {}).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  const pm2 = data?.pm2 || []
  const wa = data?.wa || {}

  return (
    <div className="view active" id="dashboard-view">
      <div className="dash-grid">
        <motion.div className="dash-card" {...card} transition={{ delay: 0 }}>
          <h4>💻 Console Tasks <button className="refresh-btn" onClick={refresh} title="Refresh">↻</button></h4>
          {!tasks.length ? <div className="dash-empty">No tasks recorded yet.</div> : tasks.map((t, i) => {
            const elapsed = t.createdAt ? Math.round((Date.now() - t.createdAt) / 1000) : 0
            const elStr = elapsed >= 60 ? `${Math.floor(elapsed / 60)}m${elapsed % 60}s` : `${elapsed}s`
            const meta = t.status === 'running' ? `running · ${elStr}` : t.status + (t.finishedAt ? ` · ${Math.round((Date.now() - t.finishedAt) / 60000)}m ago` : '')
            return (
              <div className="dash-task" key={i}>
                <span className={'status-dot ' + t.status} />
                <div><div>{t.description || t.id}</div><div className="dash-task-meta">{meta}</div></div>
              </div>
            )
          })}
        </motion.div>
        <motion.div className="dash-card" {...card} transition={{ delay: 0.07 }}>
          <h4>⚙ PM2 Processes</h4>
          {!pm2.length ? <div className="dash-empty">No PM2 data.</div> : pm2.map((p, i) => {
            const status = (p.pm2_env && p.pm2_env.status) || p.status || 'unknown'
            const mem = p.monit?.memory ? (p.monit.memory / 1e6).toFixed(1) + 'MB' : '—'
            const cpu = p.monit?.cpu != null ? p.monit.cpu + '%' : '—'
            return (
              <div className="pm2-row" key={i}>
                <span className={'pm2-dot ' + status} />
                <span className="pm2-name">{p.name || '?'}</span>
                <span className="pm2-meta">{status} · {cpu} · {mem}</span>
              </div>
            )
          })}
        </motion.div>
        <motion.div className="dash-card" {...card} transition={{ delay: 0.14 }}>
          <h4>📱 WhatsApp</h4>
          <div className="wa-status-row">
            <span className={'wa-big-dot ' + (wa.ready ? 'ready' : wa.needsQR ? 'qr' : 'offline')} />
            <span>{wa.ready ? 'Connected' : wa.needsQR ? 'Needs QR scan' : wa.status || 'Offline'}</span>
          </div>
          {wa.needsQR && <div className="dash-hint">Open C:\server-hub\whatsapp-mcp\qr.png and scan with WhatsApp → Linked Devices</div>}
        </motion.div>
        <motion.div className="dash-card" {...card} transition={{ delay: 0.21 }}>
          <h4>📉 Usage Limits</h4>
          {!usage?.ok ? <div className="dash-empty">{usage?.error || 'Loading usage…'}</div> : usage.windows.map((w) => (
            <div className="usage-row" key={w.id}>
              <div className="usage-row-head">
                <span>{w.label}</span>
                <span>{w.pct}%{w.resetsAt ? ' · resets in ' + untilStr(w.resetsAt) : ''}</span>
              </div>
              <div className="usage-bar">
                <div className={'ubar-fill ' + (w.pct >= 85 ? 'crit' : w.pct >= 60 ? 'warn' : 'ok')} style={{ width: Math.min(w.pct, 100) + '%' }} />
              </div>
            </div>
          ))}
        </motion.div>
        <AnalyticsCard analytics={analytics} />
        <LogsCard pm2={pm2} />
      </div>
      <div id="dash-updated">{updated && 'Updated ' + updated}</div>
    </div>
  )
}

function AnalyticsCard({ analytics }) {
  const days = (analytics?.days || []).slice(-7)
  const max = Math.max(1, ...days.map((d) => d.in + d.out))
  return (
    <motion.div className="dash-card" {...card} transition={{ delay: 0.28 }}>
      <h4>📊 Token Analytics <span className="dash-sub">(14d: ↑{fmtN(analytics?.totals?.in || 0)} ↓{fmtN(analytics?.totals?.out || 0)} · {analytics?.totals?.turns || 0} turns)</span></h4>
      {!analytics?.ok || !analytics.totals.turns ? <div className="dash-empty">No usage recorded yet — chat a bit first.</div> : (
        <div className="ana-chart">
          {days.map((d) => (
            <div className="ana-col" key={d.key} title={d.day + ' — in ' + fmtN(d.in) + ' / out ' + fmtN(d.out) + ' / ' + d.turns + ' turns'}>
              <div className="ana-bars">
                <div className="ana-bar in" style={{ height: Math.max(d.in + d.out ? 4 : 0, ((d.in) / max) * 90) + 'px' }} />
                <div className="ana-bar out" style={{ height: Math.max(d.out ? 3 : 0, ((d.out) / max) * 90) + 'px' }} />
              </div>
              <div className="ana-day">{d.day.slice(3)}</div>
            </div>
          ))}
        </div>
      )}
    </motion.div>
  )
}

function LogsCard({ pm2 }) {
  const [proc, setProc] = useState('')
  const [lines, setLines] = useState([])
  const [live, setLive] = useState(false)
  const esRef = useRef(null)
  const preRef = useRef(null)

  const stop = () => { esRef.current?.close(); esRef.current = null; setLive(false) }
  const start = (name) => {
    stop()
    if (!name) return
    setLines([])
    const es = new EventSource('/api/logs?proc=' + encodeURIComponent(name))
    es.onmessage = (e) => setLines((l) => [...l.slice(-400), e.data])
    es.onerror = () => stop()
    esRef.current = es
    setLive(true)
  }
  useEffect(() => stop, [])
  useEffect(() => { const el = preRef.current; if (el) el.scrollTop = el.scrollHeight }, [lines])

  return (
    <motion.div className="dash-card logs-card" {...card} transition={{ delay: 0.35 }}>
      <h4>📜 Live Logs
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <select className="finput logs-sel" value={proc} onChange={(e) => { setProc(e.target.value); start(e.target.value) }}>
            <option value="">— pick process —</option>
            {pm2.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
          </select>
          {live && <button className="mini" onClick={stop}>■ stop</button>}
        </span>
      </h4>
      {!proc ? <div className="dash-empty">Select a PM2 process to stream its logs.</div> : (
        <pre className="logs-pre" ref={preRef}>{lines.length ? lines.join('\n') : 'Waiting for output…'}</pre>
      )}
    </motion.div>
  )
}
