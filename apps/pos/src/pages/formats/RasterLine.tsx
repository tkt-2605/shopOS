import { useEffect, useRef } from 'react'
import { Receipt, type PaperSize } from '@shopos/core'

/**
 * The logo in the roll preview, drawn from the very dots the printer is sent --
 * black and white, at the printer's own resolution -- so a logo that will come
 * out as a smudge looks like one here, before a roll is wasted finding out.
 */
export function RasterLine({ raster, paper }: { raster: Receipt.Raster; paper: PaperSize }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const ctx = canvas.current?.getContext('2d')
    if (!ctx) return
    const image = ctx.createImageData(raster.width, raster.height)
    const rowBytes = raster.width / 8
    for (let y = 0; y < raster.height; y++) {
      for (let x = 0; x < raster.width; x++) {
        const black = (raster.bits[y * rowBytes + (x >> 3)]! & (0x80 >> (x & 7))) !== 0
        const i = (y * raster.width + x) * 4
        image.data[i] = image.data[i + 1] = image.data[i + 2] = black ? 0 : 255
        image.data[i + 3] = 255
      }
    }
    ctx.putImageData(image, 0, 0)
  }, [raster])
  return (
    <canvas
      ref={canvas}
      className="receipt-raster"
      width={raster.width}
      height={raster.height}
      style={{ width: `${(raster.width / Receipt.rollDots(paper)) * 100}%` }}
    />
  )
}
