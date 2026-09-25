// Generates the DarkSol eclipse mark: a black disc, a thin bright limb and a
// stippled corona with ray-like streamers. The corona is hundreds of seeded
// particles, so it is generated rather than drawn by hand. Rerun after tuning:
//   node scripts/eclipse-mark.mjs
// Writes public/logo.svg (transparent, for the app shell) and public/favicon.svg
// (on a dark tile, so the white corona still shows in a light browser tab).
import { writeFileSync } from 'node:fs'

function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Particles in a 100-unit box around a disc of `radius`, as { x, y, alpha, size }.
function corona(random, radius, density) {
  const dots = []
  const add = (distance, angle, alpha, size) => {
    const reach = radius + distance
    if (reach < 49) dots.push({ x: 50 + Math.cos(angle) * reach, y: 50 + Math.sin(angle) * reach, alpha, size })
  }
  // A dense band hugging the limb, thinning with distance.
  for (let i = 0; i < 560 * density; i++) {
    const distance = Math.min(9, -Math.log(1 - random() * 0.999) * 1.5)
    add(distance, random() * Math.PI * 2, 0.08 + 0.9 * Math.exp(-distance / 2.6), 0.2 + random() * 0.22)
  }
  // Streamers: narrow rays at irregular angles, brightest at the base.
  const streamers = 15
  for (let s = 0; s < streamers; s++) {
    const angle = (s + random() * 0.8) / streamers * Math.PI * 2
    const length = 6 + random() * 11
    const width = 0.03 + random() * 0.05
    for (let i = 0; i < (18 + length * 5) * density; i++) {
      const t = random() ** 1.4
      const spread = (random() + random() + random() - 1.5) / 1.5 * width * (1 - 0.6 * t)
      add(0.4 + t * length, angle + spread, 0.06 + 0.8 * (1 - t) ** 1.3, 0.18 + random() * 0.16)
    }
  }
  // A few loose specks further out.
  for (let i = 0; i < 28 * density; i++) add(11 + random() * 8, random() * Math.PI * 2, 0.12 + random() * 0.3, 0.22 + random() * 0.18)
  return dots
}

// Dots become zero-length round-capped strokes, one path per size and opacity
// bucket, which keeps the file a fraction of the size of individual circles.
function dotPaths(dots, sizeScale) {
  const alphas = [0.14, 0.28, 0.45, 0.65, 0.9]
  const sizes = [0.34, 0.5, 0.7]
  const nearest = (values, target) => values.reduce((best, value) => Math.abs(value - target) < Math.abs(best - target) ? value : best)
  const buckets = new Map()
  for (const dot of dots) {
    const key = `${nearest(sizes, dot.size * 2)}|${nearest(alphas, dot.alpha)}`
    buckets.set(key, (buckets.get(key) ?? '') + `M${dot.x.toFixed(1)} ${dot.y.toFixed(1)}h0`)
  }
  return [...buckets].map(([key, d]) => {
    const [size, alpha] = key.split('|')
    return `<path stroke-width="${+(size * sizeScale).toFixed(2)}" stroke-opacity="${alpha}" d="${d}"/>`
  }).join('')
}

function mark({ radius, ring, sizeScale, density, tile }) {
  const dots = dotPaths(corona(mulberry32(20260925), radius, density), sizeScale)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${tile ? '<rect width="100" height="100" rx="22" fill="#080808"/>' : ''}`
    + `<g fill="none" stroke="#F2F2F2" stroke-linecap="round">${dots}</g>`
    + `<circle cx="50" cy="50" r="${radius}" fill="#050505" stroke="#F5F5F5" stroke-width="${ring}"/></svg>\n`
}

const publicDir = new URL('../public/', import.meta.url)
writeFileSync(new URL('logo.svg', publicDir), mark({ radius: 32, ring: 1.6, sizeScale: 1, density: 1, tile: false }))
// Tab icons render at 16-32px, so the favicon gets a heavier limb and fewer, larger dots.
writeFileSync(new URL('favicon.svg', publicDir), mark({ radius: 29, ring: 4, sizeScale: 1.9, density: 0.6, tile: true }))
