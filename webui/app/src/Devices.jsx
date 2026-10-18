import React, { useCallback, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import QRCode from 'qrcode'
import { getJSON, postJSON, dpath, emit } from './api.js'

const fmtMem = (n) => (n == null ? '' : n >= 1073741824 ? (n / 1073741824).toFixed(1) + 'G' : (n / 1048576).toFixed(0) + 'M')

export default function Devices({ visible, onPick }) {
  const [data, setData] = useState(null)
  const [busy, setBusy] = useState('')

  const load = useCallback(async () => {
    try { setData(await getJSON('/devices')) } catch { setData({ ok: false, devices: [] }) }
  }, [])

  useEffect(() => { if (visible) { load(); const t = setInterval(load, 20000); return () => clearInterval(t) } }, [visible, load])

  const editSsh = async (d) => {
    const sshUser = prompt('SSH username for ' + d.name + ' (used by the web terminal & VS Code Remote-SSH):', d.sshUser || '')
    if (sshUser === null) return
    const sshPort = prompt('SSH port for ' + d.name + ':', String(d.sshPort || 22))
    if (sshPort === null) return
    try {
      await postJSON('/devices', { id: d.id, name: d.name, host: d.host, agentPort: d.agentPort, kind: d.kind, sshUser: sshUser.trim(), sshPort: parseInt(sshPort, 10) || 22 })
      emit('toast', { text: '🔐 SSH login saved for ' + d.name })
      load()
    } catch { emit('toast', { text: '❌ save failed' }) }
  }
  const copyKey = async (d) => {
    try {
      const r = await getJSON(dpath('/device/pubkey', d.self ? '' : d.id))
      if (!r.pubkey) return emit('toast', { text: '❌ No SSH key on ' + d.name + ' — run phase2-ssh-keys.ps1 there' })
      navigator.clipboard?.writeText(r.pubkey)
      emit('toast', { text: '🔑 Copied ' + d.name + "'s public key", sub: 'Add it to the OTHER node’s authorized_keys' })
    } catch { emit('toast', { text: '❌ could not fetch key' }) }
  }

  const pm2 = async (deviceId, action, name) => {
    if ((action === 'stop') && !confirm(`Stop "${name}" on this device?`)) return
    setBusy(deviceId + name + action)
    try {
      const r = await (await postJSON(dpath('/command', deviceId), { cmd: 'pm2-action', action, name })).json()
      emit('toast', { text: r.ok ? `✅ ${action} ${name}` : '❌ ' + (r.error || 'failed') })
      load()
    } catch { emit('toast', { text: '❌ command failed' }) }
    setBusy('')
  }

  if (!visible) return null
  return (
    <div className="view active" id="devices-view">
      <div className="dev-wrap">
        <ConnectCard />
        {!data ? <div className="dash-empty">Loading devices…</div> : (
          <>
            {!data.hasToken && (
              <div className="dev-warn">⚠ No <code>HUB_DEVICE_TOKEN</code> set — cross-device control is disabled. Set the same token in <code>.env</code> on every node to enable it.</div>
            )}
            <div className="dev-grid">
              {data.devices.map((d) => (
                <motion.div key={d.id} className={'dev-card' + (d.online ? '' : ' offline')} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
                  <div className="dev-head">
                    <span className={'dev-dot ' + (d.online ? 'on' : 'off')} />
                    <span className="dev-name">{d.name}</span>
                    {d.self && <span className="dev-tag self">this</span>}
                    <span className="dev-tag">{d.kind}</span>
                  </div>
                  <div className="dev-meta">
                    {d.health?.hostname && <span>🖥 {d.health.hostname}</span>}
                    {d.host && d.host !== 'self' && <span>🔗 {d.host}:{d.agentPort}</span>}
                    {(d.sshUser || d.sshPort) && <span title="SSH login for the web terminal / VS Code Remote-SSH">🔐 {d.sshUser || '?'}@…:{d.sshPort || 22}</span>}
                    {d.health?.runningTasks > 0 && <span>⚙ {d.health.runningTasks} task{d.health.runningTasks > 1 ? 's' : ''}</span>}
                  </div>
                  {d.health?.workdir && <div className="dev-workdir" title={d.health.workdir}>📂 {d.health.workdir}</div>}
                  <div className="dev-ssh">
                    <button className="mini ghost" title="Set SSH username/port" onClick={() => editSsh(d)}>🔐 SSH login</button>
                    <button className="mini ghost" title="Copy this device’s SSH public key" onClick={() => copyKey(d)}>🔑 Copy key</button>
                    {d.online && <button className="mini" title={'Open a console on ' + d.name} onClick={() => emit('open-terminal', { device: d.self ? '' : d.id, deviceName: d.name, cwd: '' })}>{'>_'} Console</button>}
                  </div>
                  {!d.online ? (
                    <div className="dash-empty" style={{ padding: '8px 0' }}>Offline — power on this device or check Tailscale.</div>
                  ) : (
                    <>
                      <div className="dev-sec">Processes</div>
                      <div className="dev-procs">
                        {(d.health?.pm2 || []).length === 0 && <div className="dash-empty" style={{ padding: '4px 0' }}>No pm2 processes.</div>}
                        {(d.health?.pm2 || []).map((pr) => (
                          <div key={pr.name} className="dev-proc">
                            <span className={'proc-st ' + (pr.status === 'online' ? 'on' : 'off')}>{pr.status}</span>
                            <span className="file-name" title={pr.name}>{pr.name}</span>
                            {pr.memory != null && <span className="proc-mem">{fmtMem(pr.memory)}</span>}
                            <span className="proc-actions">
                              <button className="mini ghost" disabled={!!busy} title="Restart" onClick={() => pm2(d.self ? '' : d.id, 'restart', pr.name)}>↻</button>
                              <button className="mini ghost" disabled={!!busy} title={pr.status === 'online' ? 'Stop' : 'Start'} onClick={() => pm2(d.self ? '' : d.id, pr.status === 'online' ? 'stop' : 'start', pr.name)}>{pr.status === 'online' ? '■' : '▶'}</button>
                            </span>
                          </div>
                        ))}
                      </div>
                      <div className="dev-foot">
                        <button className="mini" onClick={() => { onPick?.(d.self ? '' : d.id); emit('switch-tab', { tab: 'files' }); emit('toast', { text: '📂 Files scoped to ' + d.name }) }}>📂 Browse files</button>
                        <button className="mini" onClick={() => { onPick?.(d.self ? '' : d.id); emit('switch-tab', { tab: 'sessions' }); emit('toast', { text: '🖥 Sessions on ' + d.name }) }}>🖥 Sessions</button>
                      </div>
                    </>
                  )}
                </motion.div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// "Connect a device" — the easy-access card: scannable QR + copyable URLs so
// any tailnet phone/tablet opens the hub without hunting for the address.
function ConnectCard() {
  const [qr, setQr] = useState('')
  const url = typeof location !== 'undefined' ? location.origin : ''
  const host = typeof location !== 'undefined' ? location.hostname : ''
  // Suggest the friendlier MagicDNS short name only when reached by a hostname
  // (not a raw IP or localhost — those have no useful short form).
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
  const magic = (isIp || host === 'localhost' || !host.includes('.')) ? null : host.split('.')[0]

  useEffect(() => {
    if (!url) return
    QRCode.toDataURL(url, { margin: 1, width: 220, color: { dark: '#0a0c10', light: '#ffffff' } }).then(setQr).catch(() => {})
  }, [url])

  const copy = (t) => { navigator.clipboard?.writeText(t).then(() => emit('toast', { text: '📋 Copied ' + t })).catch(() => {}) }

  return (
    <motion.div className="connect-card" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
      <div className="connect-qr">{qr ? <img src={qr} alt="QR to open the hub" /> : <div className="dash-empty">QR…</div>}</div>
      <div className="connect-info">
        <h3>📲 Open on another device</h3>
        <p>Scan with any phone/tablet on your tailnet, or install this page as an app (browser menu → <b>Add to Home screen</b>) for a one-tap icon.</p>
        <div className="connect-url" onClick={() => copy(url)} title="Click to copy">{url} <span className="copy-ic">📋</span></div>
        {magic && <div className="connect-hint">Tip: with Tailscale MagicDNS on, you can also use <code onClick={() => copy('http://' + magic + ':' + location.port)}>http://{magic}:{location.port}</code></div>}
      </div>
    </motion.div>
  )
}
