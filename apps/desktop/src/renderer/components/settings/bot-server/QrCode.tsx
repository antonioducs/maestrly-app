import { useMemo } from 'react'
import { encode } from 'uqr'

/** A QR code drawn as one SVG path: one unit square per dark module, on a white quiet zone. */
export function QrCode({ text, label, className }: { text: string; label: string; className?: string }) {
  const { size, path } = useMemo(() => {
    const qr = encode(text, { ecc: 'M', border: 2 })
    let d = ''
    qr.data.forEach((row, y) =>
      row.forEach((dark, x) => {
        if (dark) d += `M${x} ${y}h1v1h-1z`
      })
    )
    return { size: qr.size, path: d }
  }, [text])
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      className={className}
    >
      <rect width={size} height={size} fill="#ffffff" />
      <path d={path} fill="#131514" />
    </svg>
  )
}
