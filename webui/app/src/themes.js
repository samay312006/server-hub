// Theme registry — every theme is a full CSS-variable set applied to :root.
// data-theme also lands on <html> so themes can add ambient effects in CSS.
// Each theme also owns a 3D scene + character (see three/Scenes.jsx).
// --glass / --glass2 are translucent panel colors used by glass surfaces
// so the WebGL scene glows through the chrome.
export const THEMES = {
  midnight: {
    name: 'Midnight', icon: '🌃', character: 'Cosmo & Nova', tagline: 'cosmic crew aboard',
    vars: {
      '--bg': '#0a0c10', '--panel': '#11141b', '--panel2': '#171b24', '--border': '#262b36',
      '--glass': 'rgba(17,20,27,.66)', '--glass2': 'rgba(23,27,36,.5)',
      '--text': '#e8ecf3', '--muted': '#8a93a5', '--accent': '#6366f1', '--accent2': '#a855f7',
      '--tool': '#a78bfa', '--ok': '#34d399', '--warn': '#fbbf24', '--err': '#f87171',
      '--grad': 'linear-gradient(135deg,#6366f1,#a855f7)',
      '--user-bub': 'linear-gradient(135deg,#4f46e5,#7c3aed)',
      '--shadow': '0 8px 30px rgba(0,0,0,.35)', '--glow': 'rgba(99,102,241,.4)',
      '--code-bg': '#0d1117',
    },
  },
  blueberry: {
    name: 'Blueberry', icon: '🍩', character: 'Sprinkles', tagline: 'fresh out of the oven',
    vars: {
      '--bg': '#2b1551', '--panel': '#331d5e', '--panel2': '#3d2570', '--border': '#553a94',
      '--glass': 'rgba(51,29,94,.62)', '--glass2': 'rgba(61,37,112,.48)',
      '--text': '#f5efff', '--muted': '#bca8e3', '--accent': '#c084fc', '--accent2': '#f0abfc',
      '--tool': '#d8b4fe', '--ok': '#4ade80', '--warn': '#fbbf24', '--err': '#fb7185',
      '--grad': 'linear-gradient(135deg,#c084fc,#f0abfc)',
      '--user-bub': 'linear-gradient(135deg,#9333ea,#c026d3)',
      '--shadow': '0 8px 30px rgba(30,10,70,.4)', '--glow': 'rgba(192,132,252,.45)',
      '--code-bg': '#241245',
    },
  },
  daylight: {
    name: 'Daylight', icon: '☀️', character: 'Sunny', tagline: 'clear skies ahead',
    vars: {
      '--bg': '#eaf3fb', '--panel': '#ffffff', '--panel2': '#f5f8fc', '--border': '#d8e2ef',
      '--glass': 'rgba(255,255,255,.72)', '--glass2': 'rgba(247,250,253,.55)',
      '--text': '#1a2233', '--muted': '#65708a', '--accent': '#6366f1', '--accent2': '#a855f7',
      '--tool': '#7c3aed', '--ok': '#059669', '--warn': '#d97706', '--err': '#dc2626',
      '--grad': 'linear-gradient(135deg,#6366f1,#a855f7)',
      '--user-bub': 'linear-gradient(135deg,#4f46e5,#7c3aed)',
      '--shadow': '0 8px 30px rgba(30,40,80,.12)', '--glow': 'rgba(99,102,241,.3)',
      '--code-bg': '#0d1117',
    },
  },
  synthwave: {
    name: 'Synthwave', icon: '🌆', character: 'Kuba', tagline: 'holo-cube online',
    vars: {
      '--bg': '#120b1e', '--panel': '#1a1030', '--panel2': '#241640', '--border': '#3b2364',
      '--glass': 'rgba(26,16,48,.62)', '--glass2': 'rgba(36,22,64,.48)',
      '--text': '#f3e8ff', '--muted': '#a78bca', '--accent': '#f472b6', '--accent2': '#22d3ee',
      '--tool': '#22d3ee', '--ok': '#4ade80', '--warn': '#facc15', '--err': '#fb7185',
      '--grad': 'linear-gradient(135deg,#f472b6,#22d3ee)',
      '--user-bub': 'linear-gradient(135deg,#db2777,#7c3aed)',
      '--shadow': '0 8px 30px rgba(244,114,182,.18)', '--glow': 'rgba(244,114,182,.45)',
      '--code-bg': '#190f2e',
    },
  },
  matrix: {
    name: 'Matrix', icon: '🧪', character: 'Bit', tagline: 'jacked into the grid',
    vars: {
      '--bg': '#050b06', '--panel': '#0a140c', '--panel2': '#0f1d12', '--border': '#1d3a24',
      '--glass': 'rgba(10,20,12,.66)', '--glass2': 'rgba(15,29,18,.5)',
      '--text': '#d1fae5', '--muted': '#5fa874', '--accent': '#22c55e', '--accent2': '#84cc16',
      '--tool': '#86efac', '--ok': '#22c55e', '--warn': '#eab308', '--err': '#ef4444',
      '--grad': 'linear-gradient(135deg,#16a34a,#84cc16)',
      '--user-bub': 'linear-gradient(135deg,#15803d,#3f6212)',
      '--shadow': '0 8px 30px rgba(34,197,94,.15)', '--glow': 'rgba(34,197,94,.4)',
      '--code-bg': '#04130a',
    },
  },
  sakura: {
    name: 'Sakura', icon: '🌸', character: 'Hana', tagline: 'petals in the breeze',
    vars: {
      '--bg': '#fdf0f6', '--panel': '#ffffff', '--panel2': '#fdf7fa', '--border': '#f3d6e4',
      '--glass': 'rgba(255,255,255,.72)', '--glass2': 'rgba(253,247,250,.55)',
      '--text': '#3d2433', '--muted': '#a4748d', '--accent': '#ec4899', '--accent2': '#a855f7',
      '--tool': '#c026d3', '--ok': '#059669', '--warn': '#d97706', '--err': '#e11d48',
      '--grad': 'linear-gradient(135deg,#ec4899,#a855f7)',
      '--user-bub': 'linear-gradient(135deg,#db2777,#9333ea)',
      '--shadow': '0 8px 30px rgba(236,72,153,.14)', '--glow': 'rgba(236,72,153,.35)',
      '--code-bg': '#2a1622',
    },
  },
  abyss: {
    name: 'Abyss', icon: '🌊', character: 'Mochi', tagline: 'diving with the jellies',
    vars: {
      '--bg': '#06121f', '--panel': '#0a1a2b', '--panel2': '#0f2238', '--border': '#1c3a55',
      '--glass': 'rgba(10,26,43,.6)', '--glass2': 'rgba(15,34,56,.46)',
      '--text': '#dbeafe', '--muted': '#7da3c4', '--accent': '#06b6d4', '--accent2': '#3b82f6',
      '--tool': '#67e8f9', '--ok': '#34d399', '--warn': '#fbbf24', '--err': '#f87171',
      '--grad': 'linear-gradient(135deg,#06b6d4,#3b82f6)',
      '--user-bub': 'linear-gradient(135deg,#0e7490,#1d4ed8)',
      '--shadow': '0 8px 30px rgba(6,182,212,.15)', '--glow': 'rgba(6,182,212,.4)',
      '--code-bg': '#061421',
    },
  },
}

export function applyTheme(id) {
  const t = THEMES[id] || THEMES.midnight
  const root = document.documentElement
  for (const [k, v] of Object.entries(t.vars)) root.style.setProperty(k, v)
  root.dataset.theme = id
  localStorage.setItem('hub_theme', id)
  const meta = document.querySelector('meta[name=theme-color]')
  if (meta) meta.content = t.vars['--bg']
}

export const themeIds = Object.keys(THEMES)
export const nextTheme = (id) => themeIds[(themeIds.indexOf(id) + 1) % themeIds.length]
