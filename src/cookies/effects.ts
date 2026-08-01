/**
 * Cookie #2 — Glitter Burst: particle fireworks inspired by the foam pieces,
 * using only allowed colors (no green).
 */

const PALETTE = [
  '#fb923c', // coral orange
  '#fdba74', // peach
  '#fbbf24', // amber
  '#f0ab8a', // soft terracotta
  '#7dd3fc', // soft sky
  '#38bdf8', // sky
  '#fecdd3', // soft rose
  '#fff7ed', // warm cream
  '#fde68a', // pale gold
]

export function glitterBurst(x: number, y: number, intensity = 28) {
  const root = document.getElementById('fx-layer')
  if (!root) return

  for (let i = 0; i < intensity; i++) {
    const p = document.createElement('span')
    p.className = 'glitter-particle'
    const angle = (Math.PI * 2 * i) / intensity + Math.random() * 0.4
    const dist = 40 + Math.random() * 90
    const dx = Math.cos(angle) * dist
    const dy = Math.sin(angle) * dist
    const size = 3 + Math.random() * 6
    const color = PALETTE[Math.floor(Math.random() * PALETTE.length)]
    p.style.cssText = `
      left:${x}px;top:${y}px;width:${size}px;height:${size}px;
      background:${color};--dx:${dx}px;--dy:${dy}px;
      animation-duration:${0.55 + Math.random() * 0.55}s;
      box-shadow:0 0 ${4 + Math.random() * 6}px ${color};
    `
    root.appendChild(p)
    p.addEventListener('animationend', () => p.remove())
  }

  // soft flash
  const flash = document.createElement('div')
  flash.className = 'glitter-flash'
  flash.style.left = `${x}px`
  flash.style.top = `${y}px`
  root.appendChild(flash)
  flash.addEventListener('animationend', () => flash.remove())
}

export function screenShake(el: HTMLElement | null, ms = 320) {
  if (!el) return
  el.classList.add('shake')
  window.setTimeout(() => el.classList.remove('shake'), ms)
}

/** Haptic feedback when available (Android) */
export function buzz(pattern: number | number[] = 18) {
  try {
    if (navigator.vibrate) navigator.vibrate(pattern)
  } catch {
    /* ignore */
  }
}

/** Cookie #3 — Victory fanfare via Web Audio (no assets) */
export function playTone(
  freq: number,
  duration: number,
  type: OscillatorType = 'triangle',
  gain = 0.08,
  when = 0,
) {
  try {
    const ctx = getAudio()
    const t0 = ctx.currentTime + when
    const osc = ctx.createOscillator()
    const g = ctx.createGain()
    osc.type = type
    osc.frequency.value = freq
    g.gain.setValueAtTime(gain, t0)
    g.gain.exponentialRampToValueAtTime(0.001, t0 + duration)
    osc.connect(g)
    g.connect(ctx.destination)
    osc.start(t0)
    osc.stop(t0 + duration + 0.02)
  } catch {
    /* autoplay policy */
  }
}

let audioCtx: AudioContext | null = null
function getAudio(): AudioContext {
  if (!audioCtx) {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    audioCtx = new AC()
  }
  if (audioCtx.state === 'suspended') void audioCtx.resume()
  return audioCtx
}

export function sfxMiss() {
  playTone(220, 0.12, 'sine', 0.05)
  playTone(180, 0.18, 'sine', 0.04, 0.05)
  buzz(12)
}

export function sfxHit() {
  playTone(440, 0.08, 'square', 0.06)
  playTone(660, 0.12, 'triangle', 0.07, 0.06)
  buzz([10, 30, 20])
}

export function sfxSunk() {
  const notes = [523, 659, 784, 1046]
  notes.forEach((n, i) => playTone(n, 0.2, 'triangle', 0.09, i * 0.09))
  buzz([20, 40, 20, 40, 60])
}

export function sfxVictory() {
  const melody = [523, 659, 784, 1046, 784, 1046, 1318]
  melody.forEach((n, i) => playTone(n, 0.22, 'triangle', 0.1, i * 0.12))
  buzz([40, 60, 40, 60, 80])
}

export function sfxRadar() {
  playTone(880, 0.06, 'sine', 0.05)
  playTone(1320, 0.2, 'sine', 0.04, 0.08)
  buzz(25)
}

export function sfxPlace() {
  playTone(520, 0.07, 'triangle', 0.05)
  buzz(8)
}

export function unlockAudio() {
  try {
    getAudio()
  } catch {
    /* ignore */
  }
}
