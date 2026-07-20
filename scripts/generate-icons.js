#!/usr/bin/env node
/**
 * Generates placeholder PWA icons for GraceTracks.
 * Dark background (#1E2227) with Signal Blue "GT" text (#4EA6E6) in a bold style.
 * Run once: node scripts/generate-icons.js
 */
const { createCanvas } = require('canvas')
const fs = require('fs')
const path = require('path')

const SIZES = [192, 512]
const BG = '#1E2227'
const FG = '#4EA6E6'
const OUT_DIR = path.join(__dirname, '..', 'public', 'icons')

fs.mkdirSync(OUT_DIR, { recursive: true })

for (const size of SIZES) {
  const canvas = createCanvas(size, size)
  const ctx = canvas.getContext('2d')

  // Background
  ctx.fillStyle = BG
  ctx.fillRect(0, 0, size, size)

  // Rounded rect inset (subtle border)
  const r = size * 0.12
  ctx.fillStyle = '#2A3036'
  ctx.beginPath()
  ctx.moveTo(r, 0)
  ctx.lineTo(size - r, 0)
  ctx.quadraticCurveTo(size, 0, size, r)
  ctx.lineTo(size, size - r)
  ctx.quadraticCurveTo(size, size, size - r, size)
  ctx.lineTo(r, size)
  ctx.quadraticCurveTo(0, size, 0, size - r)
  ctx.lineTo(0, r)
  ctx.quadraticCurveTo(0, 0, r, 0)
  ctx.closePath()
  ctx.fill()

  // "GT" text
  const fontSize = Math.round(size * 0.42)
  ctx.fillStyle = FG
  ctx.font = `bold ${fontSize}px sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('GT', size / 2, size / 2)

  // Write PNG
  const outPath = path.join(OUT_DIR, `icon-${size}.png`)
  fs.writeFileSync(outPath, canvas.toBuffer('image/png'))
  console.log(`✓ ${outPath}`)
}
