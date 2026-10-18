import React, { useEffect, useRef } from 'react'
import { marked } from 'marked'
import hljs from 'highlight.js/lib/common'
import 'highlight.js/styles/github-dark.css'

marked.setOptions({ breaks: true, gfm: true })

// Markdown bubble for assistant output. `live` skips highlight/copy wiring
// while a message is still streaming (cheap re-renders), then the final pass
// highlights code and attaches copy buttons.
export default function Markdown({ text, live }) {
  const ref = useRef(null)

  useEffect(() => {
    const el = ref.current
    if (!el || live) return
    el.querySelectorAll('pre code').forEach((block) => {
      try { hljs.highlightElement(block) } catch {}
      const pre = block.parentElement
      if (pre.querySelector('.copy-btn')) return
      const btn = document.createElement('button')
      btn.className = 'copy-btn'
      btn.textContent = 'Copy'
      btn.onclick = (e) => {
        e.stopPropagation()
        navigator.clipboard.writeText(block.textContent || '').then(() => {
          btn.textContent = 'Copied!'
          btn.classList.add('copied')
          setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied') }, 1500)
        }).catch(() => {})
      }
      pre.appendChild(btn)
    })
  }, [text, live])

  return <div ref={ref} className="msg bot-md" dangerouslySetInnerHTML={{ __html: marked.parse(text || '') }} />
}
