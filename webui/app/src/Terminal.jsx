import React, { useEffect, useRef, useState } from 'react'
import { Terminal as Xterm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { on } from './api.js'

// In-browser terminal drawer. Each tab is one xterm.js instance bridged over a
// websocket (/api/term) to an SSH session that THIS hub node opens into the
// selected target device — so the console opens "on the device interacting with
// the WebUI", SSH'd into the target. Open a tab via emit('open-terminal', { device, deviceName, cwd }).
export default function Terminal() {
  const [open, setOpen] = useState(false)
  const [full, setFull] = useState(false)
  const [tabs, setTabs] = useState([])      // { id, device, deviceName, cwd }
  const [active, setActive] = useState('')

  useEffect(() => on('open-terminal', ({ device, deviceName, cwd }) => {
    const id = 't' + Math.random().toString(36).slice(2, 8)
    setTabs((t) => [...t, { id, device: device || '', deviceName: deviceName || 'this device', cwd: cwd || '' }])
    setActive(id)
    setOpen(true)
  }), [])

  const closeTab = (id) => {
    setTabs((t) => {
      const next = t.filter((x) => x.id !== id)
      setActive((a) => (a === id ? (next[next.length - 1]?.id || '') : a))
      if (next.length === 0) setOpen(false)
      return next
    })
  }

  if (!open) return null

  return (
    <div className={'term-drawer' + (full ? ' full' : '')}>
      <div className="term-bar">
        <div className="term-tabs">
          {tabs.map((t) => (
            <button key={t.id} className={'term-tab' + (t.id === active ? ' on' : '')} onClick={() => setActive(t.id)}
              title={(t.deviceName) + (t.cwd ? ' — ' + t.cwd : '')}>
              {'>_'} {t.deviceName}
              <span className="term-x" onClick={(e) => { e.stopPropagation(); closeTab(t.id) }}>×</span>
            </button>
          ))}
        </div>
        <div className="term-actions">
          <button className="term-btn" title={full ? 'Restore' : 'Maximize'} onClick={() => setFull((f) => !f)}>{full ? '🗗' : '🗖'}</button>
          <button className="term-btn" title="Close terminal" onClick={() => { setTabs([]); setOpen(false) }}>×</button>
        </div>
      </div>
      <div className="term-body">
        {tabs.map((t) => (
          <TermTab key={t.id} spec={t} active={t.id === active} />
        ))}
      </div>
    </div>
  )
}

function TermTab({ spec, active }) {
  const wrapRef = useRef(null)
  const termRef = useRef(null)
  const fitRef = useRef(null)
  const wsRef = useRef(null)

  useEffect(() => {
    const term = new Xterm({
      fontSize: 13, cursorBlink: true, convertEol: false,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      theme: { background: '#0b0e14', foreground: '#d7dce5' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(wrapRef.current)
    try { fit.fit() } catch (_) {}
    termRef.current = term
    fitRef.current = fit

    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const qs = '?device=' + encodeURIComponent(spec.device) + (spec.cwd ? '&cwd=' + encodeURIComponent(spec.cwd) : '')
    const ws = new WebSocket(proto + '://' + location.host + '/api/term' + qs)
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    const enc = new TextEncoder()
    const sendResize = () => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
    }
    ws.onopen = () => sendResize()
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') term.write(ev.data)
      else term.write(new Uint8Array(ev.data))
    }
    ws.onclose = () => term.write('\r\n\x1b[2m[disconnected]\x1b[0m\r\n')
    term.onData((d) => { if (ws.readyState === WebSocket.OPEN) ws.send(enc.encode(d)) })
    term.onResize(() => sendResize())

    const ro = new ResizeObserver(() => { try { fit.fit() } catch (_) {} })
    ro.observe(wrapRef.current)

    return () => { ro.disconnect(); try { ws.close() } catch (_) {} term.dispose() }
  }, [])

  // Refit when this tab becomes visible (xterm can't measure a hidden element).
  useEffect(() => {
    if (active && fitRef.current) { const id = setTimeout(() => { try { fitRef.current.fit() } catch (_) {} termRef.current?.focus() }, 30); return () => clearTimeout(id) }
  }, [active])

  return <div ref={wrapRef} className="term-pane" style={{ display: active ? 'block' : 'none' }} />
}
