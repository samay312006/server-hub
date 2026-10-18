// Tiny event bus — decouples chat/mascot/toasts/palette without prop drilling.
export const bus = new EventTarget()
export const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }))
export const on = (type, fn) => {
  const h = (e) => fn(e.detail)
  bus.addEventListener(type, h)
  return () => bus.removeEventListener(type, h)
}

// Append ?device=<id> so the call is proxied to that peer (empty/self = local).
export function dpath(p, device) {
  if (!device) return p
  return p + (p.includes('?') ? '&' : '?') + 'device=' + encodeURIComponent(device)
}

export async function api(path, opts = {}) {
  const r = await fetch('/api' + path, { headers: { 'Content-Type': 'application/json' }, ...opts })
  if (r.status === 401) emit('logout')
  return r
}
export const getJSON = async (p) => { const r = await api(p); if (!r.ok) throw new Error('http ' + r.status); return r.json() }
export const postJSON = (p, body) => api(p, { method: 'POST', body: JSON.stringify(body || {}) })
export const patchJSON = (p, body) => api(p, { method: 'PATCH', body: JSON.stringify(body || {}) })
export const delReq = (p) => api(p, { method: 'DELETE' })

// NDJSON streaming for /api/chat
export async function streamChat(body, handlers, signal) {
  const r = await api('/chat', { method: 'POST', body: JSON.stringify(body), signal })
  if (r.status === 401) throw new Error('unauthorized')
  handlers.onMeta?.(r.headers.get('X-Session-Id'), r.headers.get('X-Conv-Id'))
  const reader = r.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      let ev
      try { ev = JSON.parse(line) } catch { continue }
      handlers.onEvent(ev)
    }
  }
}

export const fmtTime = (ts) => new Date(ts || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
export const fmtN = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n))
