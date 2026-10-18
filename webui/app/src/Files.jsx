import React, { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { getJSON, postJSON, dpath, emit, fmtN } from './api.js'

const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B')
const ICONS = { js: '🟨', jsx: '⚛️', ts: '🟦', tsx: '⚛️', json: '🧾', md: '📝', css: '🎨', html: '🌐', py: '🐍', png: '🖼', jpg: '🖼', jpeg: '🖼', gif: '🖼', svg: '🖼', webp: '🖼', env: '🔐', lock: '🔒', sql: '🗄', sh: '⌨️', ps1: '⌨️', bat: '⌨️' }
const fileIcon = (name, dir) => dir ? '📁' : (ICONS[name.split('.').pop()?.toLowerCase()] || '📄')

export default function Files({ visible, device = '' }) {
  const [dir, setDir] = useState('')
  const [listing, setListing] = useState({ root: '', entries: [] })
  const [sel, setSel] = useState('')
  const [preview, setPreview] = useState(null)
  const [git, setGit] = useState(null)
  const [gh, setGh] = useState(null)
  const [ghAccounts, setGhAccounts] = useState([])
  const [branches, setBranches] = useState([])
  const [diff, setDiff] = useState(null)
  const [commitMsg, setCommitMsg] = useState('')
  const [busy, setBusy] = useState('')
  const [branchMenu, setBranchMenu] = useState(false)
  const [stashMenu, setStashMenu] = useState(false)
  const [stashes, setStashes] = useState([])
  const fileInput = useRef(null)

  const load = useCallback(async (d = dir) => {
    try { setListing(await getJSON(dpath('/files?dir=' + encodeURIComponent(d), device))) } catch {}
  }, [dir, device])
  const loadGit = useCallback(async () => {
    try { setGit(await getJSON(dpath('/git/status', device))) } catch {}
    try { const b = await getJSON(dpath('/git/branches', device)); setBranches(b.ok ? b.branches : []) } catch {}
    try { setGh(await getJSON(dpath('/github', device))) } catch {}
    try { const a = await getJSON(dpath('/github/accounts', device)); setGhAccounts(a.ok ? a.accounts : []) } catch {}
  }, [device])

  // ---- git mutations ----
  const gitPost = async (path, body, okText) => {
    setBusy(path)
    try {
      const r = await (await postJSON(dpath('/git/' + path, device), body)).json()
      if (r.ok) { if (okText) emit('toast', { text: okText }); await loadGit() }
      else emit('toast', { text: '❌ ' + (r.error || path + ' failed') })
      return r
    } catch { emit('toast', { text: '❌ ' + path + ' failed' }); return { ok: false } }
    finally { setBusy('') }
  }
  const stage = (files) => gitPost('stage', { files })
  const unstage = (files) => gitPost('unstage', { files })
  const discardFiles = (files, untracked) => {
    if (!confirm(`Discard local changes to ${files.length} file(s)? This cannot be undone.`)) return
    setDiff(null); return gitPost('discard', { files, untracked }, '🗑 Discarded changes')
  }
  const fetch_ = () => gitPost('fetch', {}, '⬇ Fetched')
  const pull = () => gitPost('pull', {}, '⬇ Pulled')
  const push = () => gitPost('push', {}, '⬆ Pushed')
  const sync = async () => { const r = await gitPost('pull', {}, '⬇ Pulled'); if (r.ok) await gitPost('push', {}, '🔄 Synced') }
  const createBranch = async () => {
    const name = prompt('New branch name:'); if (!name || !name.trim()) return
    const r = await gitPost('branch', { name: name.trim() }, '🌿 Branch ' + name.trim())
    if (r.ok) setBranchMenu(false)
  }
  const switchBranch = async (name) => { setBranchMenu(false); await gitPost('branch', { name, checkout: true }, '🌿 Switched to ' + name) }
  const deleteBranch = async (name) => {
    if (!confirm('Delete branch "' + name + '"?')) return
    const r = await gitPost('branch-delete', { name })
    if (!r.ok && /not fully merged/i.test(r.error || '')) { if (confirm('"' + name + '" is not fully merged. Force-delete?')) await gitPost('branch-delete', { name, force: true }, '🗑 Deleted ' + name) }
    else if (r.ok) emit('toast', { text: '🗑 Deleted ' + name })
  }
  const openStashMenu = async () => {
    try { const r = await (await postJSON(dpath('/git/stash', device), { action: 'list' })).json(); setStashes(r.ok ? r.stashes : []) } catch { setStashes([]) }
    setStashMenu((v) => !v)
  }
  const stashSave = async () => { const msg = prompt('Stash message (optional):') ?? ''; await gitPost('stash', { action: 'save', message: msg }, '📦 Stashed'); openStashMenu() }
  const stashAction = async (action, index) => { await gitPost('stash', { action, index }, '📦 stash ' + action); setStashMenu(false) }

  const switchGhAccount = async (user) => {
    try {
      const r = await (await postJSON(dpath('/github/switch', device), { user })).json()
      if (r.ok) {
        emit('toast', { text: '🐙 GitHub account: ' + user })
        setGh(null)
        loadGit()
      } else emit('toast', { text: '❌ ' + (r.error || 'switch failed') })
    } catch { emit('toast', { text: '❌ switch failed' }) }
  }

  useEffect(() => { if (visible) { load(dir); loadGit() } }, [visible, dir, device]) // eslint-disable-line

  const openEntry = async (e) => {
    setDiff(null)
    if (e.dir) { setDir(dir ? dir + '/' + e.name : e.name); setSel(''); setPreview(null); return }
    previewFile(dir ? dir + '/' + e.name : e.name)
  }

  const crumbs = ['', ...dir.split('/').filter(Boolean)]
  const goCrumb = (i) => { setDir(crumbs.slice(1, i + 1).join('/')); setSel(''); setPreview(null); setDiff(null) }

  const upload = async (files, targetDir = dir) => {
    for (const f of files) {
      if (f.size > 15e6) { emit('toast', { text: '❌ ' + f.name + ' too big (15MB max)' }); continue }
      const b64 = await new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(r.result.split(',')[1]); r.readAsDataURL(f) })
      await postJSON(dpath('/upload', device), { name: f.name, dataBase64: b64, dir: 'rel:' + targetDir })
    }
    emit('toast', { text: '⬆ Uploaded ' + files.length + ' file' + (files.length > 1 ? 's' : '') })
    load()
  }

  const askClaude = () => {
    if (!preview?.rel) return
    emit('switch-tab', { tab: 'chat' })
    emit('sendPrompt', { text: 'Look at the file "' + listing.root + '\\' + preview.rel.replace(/\//g, '\\') + '" and explain what it does, then point out any issues.' })
  }

  // Open a changed file's diff in the main (middle) pane, with stage/revert/resolve actions.
  const openGitFile = async (f, staged = false) => {
    setPreview(null); setSel(f.file)
    setDiff({ loading: true, file: f.file, staged, conflicted: !!f.conflicted, untracked: !!f.untracked })
    try {
      const d = await getJSON(dpath('/git/diff?file=' + encodeURIComponent(f.file) + (staged ? '&staged=1' : ''), device))
      setDiff((cur) => ({ ...cur, ...d, loading: false }))
    } catch { setDiff((cur) => ({ ...cur, error: 'failed', loading: false })) }
  }
  // Load a file's full content into the preview pane (the "View file" action / browser clicks).
  const previewFile = async (rel) => {
    setDiff(null); setSel(rel)
    const name = rel.split('/').pop()
    setPreview({ loading: true, name, rel })
    try { setPreview({ ...(await getJSON(dpath('/files/read?path=' + encodeURIComponent(rel), device))), name, rel }) }
    catch { setPreview({ error: 'failed to read', name, rel }) }
  }
  const resolveFile = async (file, side) => { await gitPost('resolve', { files: [file], side }, side ? '✓ used ' + side : '✓ marked resolved'); setDiff(null) }
  const abortMerge = () => { if (confirm('Abort the merge? In-progress merge changes are discarded.')) gitPost('abort', { op: git?.state === 'rebasing' ? 'rebase' : 'merge' }, '⛔ aborted') }
  const showCommit = async (hash) => {
    setDiff({ loading: true, file: hash, commit: true })
    try { const d = await getJSON(dpath('/git/diff?commit=' + encodeURIComponent(hash), device)); setDiff({ ...d, file: hash, commit: true }) }
    catch { setDiff({ error: 'failed', file: hash, commit: true }) }
  }

  const aiMessage = async () => {
    setBusy('ai')
    try {
      const r = await (await postJSON(dpath('/git/ai-message', device))).json()
      if (r.ok) setCommitMsg(r.message)
      else emit('toast', { text: '❌ ' + (r.error || 'no suggestion') })
    } catch { emit('toast', { text: '❌ AI message failed' }) }
    setBusy('')
  }

  const doCommit = async (all = false) => {
    if (!commitMsg.trim()) return
    setBusy('commit')
    try {
      const r = await (await postJSON(dpath('/git/commit', device), { message: commitMsg.trim(), all })).json()
      if (r.ok) { emit('toast', { text: '✅ Committed', sub: commitMsg.trim() }); setCommitMsg(''); setDiff(null); loadGit() }
      else emit('toast', { text: '❌ ' + (r.error || 'commit failed') })
    } catch { emit('toast', { text: '❌ commit failed' }) }
    setBusy('')
  }

  const renderGroup = (title, items, opts = {}) => (items || []).length > 0 && (
    <div className="git-group">
      <div className="git-group-h">
        <span>{title}</span>
        <span className="git-group-count">{(items || []).length}</span>
        {opts.bulk && <button className="mini ghost" title={opts.bulkTitle} onClick={opts.bulk}>{opts.bulkIcon}</button>}
      </div>
      {(items || []).map((f) => (
        <div key={(opts.staged ? 's:' : opts.conflict ? 'c:' : 'u:') + f.file}
          className={'git-file' + (diff?.file === f.file && !!diff?.staged === !!opts.staged && !diff?.commit ? ' active' : '')}
          onClick={() => openGitFile(f, !!opts.staged)}>
          <span className={'git-st st-' + (f.conflicted ? 'U' : f.status[0] || 'M')}>{f.status || '??'}</span>
          <span className="file-name" title={f.file}>{f.renamedFrom ? f.renamedFrom + ' → ' : ''}{f.file}</span>
          <span className="git-file-actions" onClick={(e) => e.stopPropagation()}>
            {opts.conflict
              ? <>
                  <button className="mini ghost" title="Use ours (current)" onClick={() => resolveFile(f.file, 'ours')}>ours</button>
                  <button className="mini ghost" title="Use theirs (incoming)" onClick={() => resolveFile(f.file, 'theirs')}>theirs</button>
                  <button className="mini ghost" title="Mark resolved" onClick={() => resolveFile(f.file)}>✓</button>
                </>
              : opts.staged
                ? <button className="mini ghost" title="Unstage" onClick={() => unstage([f.file])}>−</button>
                : <>
                    <button className="mini ghost" title="Discard changes" onClick={() => discardFiles([f.file], f.untracked)}>↺</button>
                    <button className="mini ghost" title="Stage" onClick={() => stage([f.file])}>＋</button>
                  </>}
          </span>
        </div>
      ))}
    </div>
  )

  // Tolerate an older backend that returns only `files` (no staged/unstaged/untracked split).
  const gfiles = git?.files || []
  const hasGroups = Array.isArray(git?.staged)
  const gstaged = git?.staged || []
  const gunstaged = git?.unstaged || []
  const guntracked = git?.untracked || []
  const gconflicts = git?.conflicts || []

  if (!visible) return null
  return (
    <div className="view active" id="files-view"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); if (e.dataTransfer.files?.length) upload([...e.dataTransfer.files]) }}>
      <div className="files-cols">

        {/* ---- left: browser ---- */}
        <motion.div className="files-pane" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          <div className="files-bar">
            <div className="crumbs">
              {crumbs.map((c, i) => (
                <span key={i}>
                  {i > 0 && <span className="crumb-sep">/</span>}
                  <button className="crumb" onClick={() => goCrumb(i)}>{i === 0 ? '🏠 ' + (listing.root?.split('\\').pop() || 'project') : c}</button>
                </span>
              ))}
            </div>
            <button className="mini" title="Upload files here" onClick={() => fileInput.current?.click()}>⬆ upload</button>
            <button className="mini" title="Refresh" onClick={() => { load(); loadGit() }}>↻</button>
            <input ref={fileInput} type="file" multiple style={{ display: 'none' }} onChange={(e) => { if (e.target.files?.length) upload([...e.target.files]); e.target.value = '' }} />
          </div>
          <div className="files-list">
            {listing.entries.length === 0 && <div className="dash-empty">Empty folder.</div>}
            {listing.entries.map((e) => {
              const rel = dir ? dir + '/' + e.name : e.name
              const st = git?.files?.find((f) => f.file === rel || f.file.startsWith(rel + '/'))
              return (
                <div key={e.name} className={'file-row' + (sel === rel ? ' active' : '')} onClick={() => openEntry(e)}>
                  <span className="file-ic">{fileIcon(e.name, e.dir)}</span>
                  <span className="file-name">{e.name}</span>
                  {st && <span className="file-git" title="modified in git">{st.status || 'M'}</span>}
                  {!e.dir && <span className="file-size">{fmtSize(e.size)}</span>}
                </div>
              )
            })}
          </div>
          <div className="files-hint">Drop files anywhere to upload to this folder</div>
        </motion.div>

        {/* ---- middle: diff (when a changed file is selected) or file preview ---- */}
        <motion.div className="files-pane preview-pane" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}>
          {diff ? (
            <>
              <div className="files-bar">
                <span className="preview-name" title={diff.file}>{diff.commit ? '⑂ ' + diff.file : (diff.conflicted ? '⚠ ' : '◐ ') + (diff.file.split('/').pop())}</span>
                <span className="diff-actions">
                  {!diff.commit && <button className="mini" title="Open full file" onClick={() => previewFile(diff.file)}>📄 file</button>}
                  {!diff.commit && diff.conflicted && (
                    <>
                      <button className="mini" onClick={() => resolveFile(diff.file, 'ours')}>use ours</button>
                      <button className="mini" onClick={() => resolveFile(diff.file, 'theirs')}>use theirs</button>
                      <button className="mini commit-btn" onClick={() => resolveFile(diff.file)}>✓ resolved</button>
                    </>
                  )}
                  {!diff.commit && !diff.conflicted && diff.staged && <button className="mini" onClick={async () => { await unstage([diff.file]); setDiff(null) }}>− unstage</button>}
                  {!diff.commit && !diff.conflicted && !diff.staged && (
                    <>
                      <button className="mini" title="Discard changes (revert)" onClick={async () => { await discardFiles([diff.file], diff.untracked); }}>↺ revert</button>
                      <button className="mini commit-btn" title="Stage (accept)" onClick={async () => { await stage([diff.file]); setDiff(null) }}>＋ stage</button>
                    </>
                  )}
                  <button className="mini" title="Close" onClick={() => { setDiff(null); setSel('') }}>×</button>
                </span>
              </div>
              {diff.loading ? <div className="dash-empty" style={{ margin: 'auto' }}>Loading diff…</div>
                : diff.error ? <div className="dash-empty" style={{ margin: 'auto' }}>{diff.error}</div>
                  : <DiffBody text={diff.diff || '(no changes)'} />}
            </>
          ) : !preview ? (
            <div className="dash-empty" style={{ margin: 'auto' }}>Select a file to preview, or a changed file to see its diff</div>
          ) : preview.loading ? (
            <div className="dash-empty" style={{ margin: 'auto' }}>Loading…</div>
          ) : (
            <>
              <div className="files-bar">
                <span className="preview-name">{fileIcon(preview.name, false)} {preview.name}</span>
                <span className="file-size">{preview.size != null ? fmtSize(preview.size) : ''}</span>
                <button className="mini" onClick={askClaude}>🧠 ask Claude</button>
                <a className="mini" href={'/api' + dpath('/files/raw?path=' + encodeURIComponent(preview.rel), device)} download={preview.name}>⬇</a>
              </div>
              {preview.image ? (
                <div className="preview-img"><img src={'/api' + dpath('/files/raw?path=' + encodeURIComponent(preview.rel), device)} alt={preview.name} /></div>
              ) : preview.content != null ? (
                <pre className="preview-code">{preview.content}</pre>
              ) : (
                <div className="dash-empty" style={{ margin: 'auto' }}>{preview.tooBig ? 'File too large to preview — download instead.' : 'Binary file — no preview.'}</div>
              )}
            </>
          )}
        </motion.div>

        {/* ---- right: git + github ---- */}
        <motion.div className="files-pane git-pane" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
          <div className="git-h-row">
            <h4 className="git-h">🌿 Source Control</h4>
            {git?.ok && (
              <div className="git-toolbar">
                <button className="mini" title="Fetch" onClick={fetch_} disabled={!!busy}>⟲</button>
                <button className="mini" title={'Pull' + (git.behind ? ' (' + git.behind + ' behind)' : '')} onClick={pull} disabled={!!busy}>⬇{git.behind > 0 ? git.behind : ''}</button>
                <button className="mini" title={'Push' + (git.ahead ? ' (' + git.ahead + ' ahead)' : '')} onClick={push} disabled={!!busy}>⬆{git.ahead > 0 ? git.ahead : ''}</button>
                <button className="mini" title="Sync — pull then push" onClick={sync} disabled={!!busy}>🔄</button>
                <button className="mini" title="Stash" onClick={openStashMenu} disabled={!!busy}>📦</button>
                <button className="mini" title="Refresh" onClick={loadGit}>↻</button>
              </div>
            )}
          </div>
          {!git?.ok ? (
            <div className="dash-empty">{git?.error || 'Loading…'}</div>
          ) : (
            <>
              <div className="git-branchbar">
                <button className="git-branch-btn" title="Switch / create branch" onClick={() => setBranchMenu((v) => !v)}>
                  ⑂ {git.branch}{!git.upstream && <span className="git-noup"> (no upstream)</span>}
                  {(git.ahead > 0 || git.behind > 0) && <span className="git-track">{git.behind > 0 ? ' ↓' + git.behind : ''}{git.ahead > 0 ? ' ↑' + git.ahead : ''}</span>}
                </button>
                {branchMenu && (
                  <div className="git-menu" onMouseLeave={() => setBranchMenu(false)}>
                    <button className="git-menu-item create" onClick={createBranch}>＋ Create new branch…</button>
                    {branches.map((b) => (
                      <div key={b.name} className={'git-menu-item' + (b.current ? ' current' : '')}>
                        <span className="git-menu-name" onClick={() => !b.current && switchBranch(b.name)}>{b.current ? '● ' : '○ '}{b.name}</span>
                        {!b.current && !b.remote && <button className="mini ghost" title="Delete branch" onClick={() => deleteBranch(b.name)}>🗑</button>}
                      </div>
                    ))}
                  </div>
                )}
                {stashMenu && (
                  <div className="git-menu stash-menu" onMouseLeave={() => setStashMenu(false)}>
                    <button className="git-menu-item create" onClick={stashSave}>＋ Stash current changes…</button>
                    {stashes.length === 0 && <div className="git-menu-empty">No stashes</div>}
                    {stashes.map((s, i) => (
                      <div key={s.ref} className="git-menu-item">
                        <span className="git-menu-name" title={s.text}>{s.text}</span>
                        <span className="stash-actions">
                          <button className="mini ghost" title="Apply & drop" onClick={() => stashAction('pop', i)}>pop</button>
                          <button className="mini ghost" title="Drop" onClick={() => stashAction('drop', i)}>✕</button>
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="git-commit">
                <input value={commitMsg} onChange={(e) => setCommitMsg(e.target.value)} placeholder={gstaged.length ? 'Commit ' + gstaged.length + ' staged…' : 'Message (stage files, or Commit All)'}
                  onKeyDown={(e) => { if (e.key === 'Enter') doCommit(false) }} />
                <button className="mini" disabled={busy === 'ai'} onClick={aiMessage} title="Draft message with AI">{busy === 'ai' ? '…' : '✨'}</button>
                <button className="mini commit-btn" disabled={busy === '/git/commit' || !commitMsg.trim() || (hasGroups && !gstaged.length)} onClick={() => doCommit(false)} title="Commit staged">Commit</button>
                <button className="mini" disabled={busy === '/git/commit' || !commitMsg.trim() || !gfiles.length} onClick={() => doCommit(true)} title="Stage all & commit">All</button>
              </div>

              {(git.state || gconflicts.length > 0) && (
                <div className="git-conflict-banner">
                  ⚠ {git.state === 'rebasing' ? 'Rebase' : 'Merge'} in progress{gconflicts.length ? ` — ${gconflicts.length} conflict${gconflicts.length > 1 ? 's' : ''} to resolve` : ''}
                  <button className="mini" onClick={abortMerge}>Abort</button>
                </div>
              )}
              {gfiles.length === 0 && <div className="git-sec">Working tree clean ✨</div>}
              {hasGroups ? (
                <>
                  {renderGroup('⚠ Conflicts', gconflicts, { conflict: true })}
                  {renderGroup('Staged Changes', gstaged, { staged: true, bulk: () => unstage(gstaged.map((f) => f.file)), bulkIcon: '−', bulkTitle: 'Unstage all' })}
                  {renderGroup('Changes', gunstaged, { bulk: () => stage(gunstaged.map((f) => f.file)), bulkIcon: '＋', bulkTitle: 'Stage all' })}
                  {renderGroup('Untracked', guntracked, { bulk: () => stage(guntracked.map((f) => f.file)), bulkIcon: '＋', bulkTitle: 'Stage all' })}
                </>
              ) : (
                renderGroup('Changes', gfiles, { bulk: () => stage(gfiles.map((f) => f.file)), bulkIcon: '＋', bulkTitle: 'Stage all' })
              )}

              <div className="git-sec" style={{ marginTop: 10 }}>Recent commits</div>
              <div className="git-log">
                {git.commits.map((c) => (
                  <div key={c.hash} className={'git-ci' + (diff?.commit && diff?.file === c.hash ? ' active' : '')} title={c.subject} onClick={() => showCommit(c.hash)}>
                    <code>{c.hash}</code><span className="git-when">{c.when}</span>
                    <span className="file-name">{c.subject}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          <h4 className="git-h" style={{ marginTop: 14 }}>🐙 GitHub
            {ghAccounts.length > 0 && (
              <select className="gh-acct" title="Active gh account (per machine — switching affects all projects)"
                value={ghAccounts.find((a) => a.active)?.user || ''}
                onChange={(e) => switchGhAccount(e.target.value)}>
                {ghAccounts.map((a) => <option key={a.user} value={a.user}>@{a.user}</option>)}
              </select>
            )}
          </h4>
          {ghAccounts.length === 1 && (
            <div className="gh-hint">Only @{ghAccounts[0].user} is logged in to gh. Add your other account with <code>gh auth login</code> — it'll appear here for switching.</div>
          )}
          {!gh ? <div className="dash-empty">Loading…</div> : !gh.ok ? (
            <div className="dash-empty">{gh.error}</div>
          ) : (
            <>
              <div className="git-sec">{gh.prs.length ? 'Open PRs' : 'No open PRs'}</div>
              {gh.prs.map((pr) => (
                <div key={pr.number} className="gh-row">
                  <a href={pr.url} target="_blank" rel="noreferrer">#{pr.number} {pr.title}</a>
                  <button className="mini" title="Ask Claude to review"
                    onClick={() => { emit('switch-tab', { tab: 'chat' }); emit('sendPrompt', { text: `Review PR #${pr.number} ("${pr.title}") in this repo using the gh CLI: look at the diff, point out bugs and improvements, and summarize.` }) }}>🧠 review</button>
                </div>
              ))}
              {gh.issues.length > 0 && <div className="git-sec" style={{ marginTop: 8 }}>Open issues</div>}
              {gh.issues.map((is) => (
                <div key={is.number} className="gh-row">
                  <a href={is.url} target="_blank" rel="noreferrer">#{is.number} {is.title}</a>
                </div>
              ))}
            </>
          )}
        </motion.div>
      </div>
    </div>
  )
}

// Colorized unified-diff renderer (+ green / − red / @@ hunks / conflict markers).
function DiffBody({ text }) {
  const lines = String(text || '').split('\n')
  return (
    <pre className="git-diff-full">
      {lines.map((l, i) => {
        let c = ''
        if (/^[+][+][+] |^--- |^diff |^index |^new file|^deleted file|^rename /.test(l)) c = 'd-meta'
        else if (l.startsWith('@@')) c = 'd-hunk'
        else if (/^(<<<<<<<|=======|>>>>>>>)/.test(l)) c = 'd-conflict'
        else if (l[0] === '+') c = 'd-add'
        else if (l[0] === '-') c = 'd-del'
        return <div key={i} className={'d-line ' + c}>{l || ' '}</div>
      })}
    </pre>
  )
}
