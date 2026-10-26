/*
 * The arithmetic of cropping a picture to a square: where the picture sits
 * behind a square frame, and which part of it the frame shows.
 *
 * Plain functions with no window in them, so they can be tested; `CropPhoto`
 * draws them.
 */

export interface Size { width: number; height: number }

/** Where the picture's top-left corner is, in frame pixels, and how much it is scaled by. */
export interface Placement { x: number; y: number; scale: number }

/** The scale at which the picture just covers the frame: its shorter side fills it. */
export function coverScale(image: Size, frame: number): number {
  return frame / Math.min(image.width, image.height)
}

/** The picture centred behind the frame at a zoom of 1 (just covering) or more. */
export function centred(image: Size, frame: number, zoom = 1): Placement {
  const scale = coverScale(image, frame) * zoom
  return { x: (frame - image.width * scale) / 2, y: (frame - image.height * scale) / 2, scale }
}

/**
 * Kept so the picture always covers the frame: no empty edge can be dragged
 * into it, at any zoom.
 */
export function clamp(p: Placement, image: Size, frame: number): Placement {
  const minX = frame - image.width * p.scale
  const minY = frame - image.height * p.scale
  return { scale: p.scale, x: Math.min(0, Math.max(minX, p.x)), y: Math.min(0, Math.max(minY, p.y)) }
}

/** Zoom about the frame's centre, so what is in the middle stays in the middle. */
export function zoomTo(p: Placement, image: Size, frame: number, zoom: number): Placement {
  const scale = coverScale(image, frame) * Math.min(4, Math.max(1, zoom))
  const cx = (frame / 2 - p.x) / p.scale
  const cy = (frame / 2 - p.y) / p.scale
  return clamp({ scale, x: frame / 2 - cx * scale, y: frame / 2 - cy * scale }, image, frame)
}

/** The square of the original picture the frame shows, in the picture's own pixels. */
export function sourceSquare(p: Placement, frame: number): { sx: number; sy: number; size: number } {
  return { sx: (0 - p.x) / p.scale, sy: (0 - p.y) / p.scale, size: frame / p.scale }
}
