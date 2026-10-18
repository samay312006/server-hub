import React, { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import confetti from 'canvas-confetti'
import { on, emit } from './api.js'

const QUIPS = {
  idle: ['All systems nominal ⚡', 'Standing by…', 'Psst — Ctrl+K', 'Hub is healthy!', 'zzz…', 'Try /btw for a side question'],
  think: ['Crunching…', 'On it!', 'Spinning gears 🛠', 'brb, thinking 🧠', 'Beep boop…'],
  happy: ['Done! ✨', 'Nailed it!', 'Easy.', 'Shipped ✅'],
  error: ['Uh oh.', 'That broke 😵', 'Mind retrying?'],
}
const pick = (a) => a[Math.floor(Math.random() * a.length)]

/* Eyes/mouth shared across characters; mood drives the expression */
function Face({ mood, cx = 40, cy = 38, gap = 11, color = '#fff' }) {
  if (mood === 'error') return (
    <g stroke={color} strokeWidth="2.4" strokeLinecap="round">
      <path d={`M${cx - gap - 4} ${cy - 4} l8 8 M${cx - gap + 4} ${cy - 4} l-8 8`} />
      <path d={`M${cx + gap - 4} ${cy - 4} l8 8 M${cx + gap + 4} ${cy - 4} l-8 8`} />
      <path d={`M${cx - 6} ${cy + 14} q6 -5 12 0`} fill="none" />
    </g>
  )
  if (mood === 'happy') return (
    <g stroke={color} strokeWidth="2.6" strokeLinecap="round" fill="none">
      <path d={`M${cx - gap - 4} ${cy} q4 -6 8 0`} />
      <path d={`M${cx + gap - 4} ${cy} q4 -6 8 0`} />
      <path d={`M${cx - 7} ${cy + 10} q7 8 14 0`} />
    </g>
  )
  if (mood === 'think') return (
    <g fill={color}>
      <circle cx={cx - gap} cy={cy - 2} r="3.4" />
      <circle cx={cx + gap} cy={cy - 2} r="3.4" />
      <circle cx={cx + 1} cy={cy + 13} r="2.2" />
    </g>
  )
  return (
    <g fill={color}>
      <circle className="blink" cx={cx - gap} cy={cy} r="3.6" />
      <circle className="blink" cx={cx + gap} cy={cy} r="3.6" />
      <path d={`M${cx - 5} ${cy + 11} q5 4 10 0`} stroke={color} strokeWidth="2.2" fill="none" strokeLinecap="round" />
    </g>
  )
}

const CHARACTERS = {
  sparky: {
    name: 'Sparky', label: '🤖 Sparky the bot',
    svg: (mood) => (
      <svg viewBox="0 0 80 80" width="74" height="74">
        <line x1="40" y1="6" x2="40" y2="16" stroke="var(--accent)" strokeWidth="3" />
        <circle cx="40" cy="6" r="4" fill="var(--accent2)" className="pulse-dot" />
        <rect x="12" y="16" width="56" height="48" rx="14" fill="var(--grad-fill,var(--accent))" opacity="0.92" />
        <rect x="20" y="24" width="40" height="32" rx="9" fill="rgba(0,0,0,.28)" />
        <Face mood={mood} cy={40} />
        <rect x="4" y="32" width="8" height="16" rx="4" fill="var(--accent2)" />
        <rect x="68" y="32" width="8" height="16" rx="4" fill="var(--accent2)" />
      </svg>
    ),
  },
  neko: {
    name: 'Neko', label: '🐱 Neko the cat',
    svg: (mood) => (
      <svg viewBox="0 0 80 80" width="74" height="74">
        <path d="M18 30 L12 8 L32 18 Z" fill="var(--accent)" />
        <path d="M62 30 L68 8 L48 18 Z" fill="var(--accent)" />
        <path d="M18 30 L15 14 L29 20 Z" fill="var(--accent2)" opacity=".7" />
        <path d="M62 30 L65 14 L51 20 Z" fill="var(--accent2)" opacity=".7" />
        <circle cx="40" cy="44" r="28" fill="var(--accent)" opacity="0.92" />
        <Face mood={mood} cy={42} color="#fff" />
        <g stroke="#fff" strokeWidth="1.6" opacity=".8">
          <line x1="8" y1="44" x2="22" y2="46" /><line x1="8" y1="52" x2="22" y2="50" />
          <line x1="72" y1="44" x2="58" y2="46" /><line x1="72" y1="52" x2="58" y2="50" />
        </g>
      </svg>
    ),
  },
  boo: {
    name: 'Boo', label: '👻 Boo the ghost',
    svg: (mood) => (
      <svg viewBox="0 0 80 80" width="74" height="74">
        <path d="M14 42 a26 26 0 0 1 52 0 v22 l-8 -6 -9 6 -9 -6 -9 6 -9 -6 -8 6 Z"
          fill="var(--accent)" opacity="0.9" />
        <Face mood={mood} cy={40} />
      </svg>
    ),
  },
  blobby: {
    name: 'Blobby', label: '🫧 Blobby the blob',
    svg: (mood) => (
      <svg viewBox="0 0 80 80" width="74" height="74">
        <path d="M40 10 C60 10 70 26 68 44 C66 62 56 70 40 70 C24 70 14 62 12 44 C10 26 20 10 40 10 Z"
          fill="var(--accent)" opacity="0.9" className="blob-morph" />
        <Face mood={mood} cy={42} />
      </svg>
    ),
  },
}
export const characterIds = Object.keys(CHARACTERS)
export const characterLabel = (id) => CHARACTERS[id]?.label || id

export function burst(big) {
  confetti({ particleCount: big ? 160 : 70, spread: big ? 100 : 70, origin: { y: 0.8 }, disableForReducedMotion: true })
}

const MOTION = {
  idle: { y: [0, -5, 0], rotate: 0, transition: { y: { duration: 2.6, repeat: Infinity, ease: 'easeInOut' } } },
  think: { y: [0, -3, 0], rotate: [-4, 4, -4], transition: { rotate: { duration: 0.9, repeat: Infinity, ease: 'easeInOut' }, y: { duration: 1.2, repeat: Infinity } } },
  happy: { y: [0, -18, 0, -10, 0], rotate: [0, -8, 8, 0], transition: { duration: 0.9 } },
  error: { x: [0, -7, 7, -5, 5, 0], y: 0, transition: { duration: 0.55 } },
}

export default function Mascot({ characterId }) {
  const [mood, setMood] = useState('idle')
  const [quip, setQuip] = useState('')
  const clicks = useRef(0)
  const quipTimer = useRef(null)
  const char = CHARACTERS[characterId] || CHARACTERS.sparky

  const say = (text, ms = 3500) => {
    setQuip(text)
    clearTimeout(quipTimer.current)
    if (ms) quipTimer.current = setTimeout(() => setQuip(''), ms)
  }

  useEffect(() => on('mood', ({ mood: m, quip: q }) => {
    setMood(m)
    if (q) say(q, m === 'think' ? 0 : 4000)
    else if (m !== 'idle') say(pick(QUIPS[m] || QUIPS.idle), m === 'think' ? 0 : 4000)
    else setQuip('')
    if (m === 'happy') setTimeout(() => setMood('idle'), 2500)
    if (m === 'error') setTimeout(() => setMood('idle'), 3000)
  }), [])

  useEffect(() => on('celebrate', () => burst(true)), [])

  // occasional idle quip
  useEffect(() => {
    const t = setInterval(() => { if (mood === 'idle' && Math.random() < 0.25) say(pick(QUIPS.idle)) }, 30000)
    return () => clearInterval(t)
  }, [mood])

  const poke = () => {
    clicks.current++
    if (clicks.current >= 7) { clicks.current = 0; burst(true); say('🎉 PARTY MODE!', 4000); setMood('happy'); setTimeout(() => setMood('idle'), 2500); return }
    setMood('happy'); setTimeout(() => setMood((m) => (m === 'happy' ? 'idle' : m)), 1200)
    say(pick(QUIPS.idle))
  }

  return (
    <div className="mascot-wrap" title={`${char.name} — click me!`}>
      <AnimatePresence>
        {quip && (
          <motion.div className="mascot-bubble" key={quip}
            initial={{ opacity: 0, y: 8, scale: 0.9 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 6, scale: 0.92 }}>
            {quip}
          </motion.div>
        )}
      </AnimatePresence>
      <motion.button className="mascot" onClick={poke} animate={MOTION[mood] || MOTION.idle}
        whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.92 }} aria-label="mascot">
        {char.svg(mood)}
        {mood === 'think' && <span className="mascot-zzz">💭</span>}
      </motion.button>
    </div>
  )
}
