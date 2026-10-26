import { describe, it, expect } from 'vitest'
import { centred, clamp, coverScale, sourceSquare, zoomTo } from '../src/ui/photoCrop'

/** Cropping an item's photo to a square: the frame is always covered, and what it shows is what is kept. */

const FRAME = 300
const wide = { width: 1200, height: 600 }

describe('cropping a photo to a square', () => {
  it('starts with the picture just covering the frame, centred', () => {
    expect(coverScale(wide, FRAME)).toBe(0.5)
    const p = centred(wide, FRAME)
    expect(p).toEqual({ x: -150, y: 0, scale: 0.5 })
    expect(sourceSquare(p, FRAME)).toEqual({ sx: 300, sy: 0, size: 600 })
  })

  it('never lets an empty edge be dragged into the frame', () => {
    const p = centred(wide, FRAME)
    expect(clamp({ ...p, x: 50, y: 40 }, wide, FRAME)).toEqual({ x: 0, y: 0, scale: 0.5 })
    expect(clamp({ ...p, x: -900 }, wide, FRAME)).toEqual({ x: -300, y: 0, scale: 0.5 })
  })

  it('zooms about the middle, between one and four times', () => {
    const p = zoomTo(centred(wide, FRAME), wide, FRAME, 2)
    expect(p.scale).toBe(1)
    expect(sourceSquare(p, FRAME)).toEqual({ sx: 450, sy: 150, size: 300 })
    expect(zoomTo(p, wide, FRAME, 10).scale).toBe(2)
    expect(zoomTo(p, wide, FRAME, 0.1).scale).toBe(0.5)
  })
})
