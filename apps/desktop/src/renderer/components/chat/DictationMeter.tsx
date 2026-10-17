import { useEffect, useRef, useState } from 'react'

/** Live microphone level as bars that scroll in from the right. Colored by the canvas's CSS `color`. */
export function DictationLevels({ stream, className }: { stream: MediaStream; className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const draw = canvas?.getContext('2d')
    if (!canvas || !draw) return
    // A detached chat draws in its own window.
    const view = canvas.ownerDocument.defaultView ?? window
    const AC =
      window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const audio = new AC()
    const source = audio.createMediaStreamSource(stream)
    const analyser = audio.createAnalyser()
    analyser.fftSize = 1024
    source.connect(analyser)
    void audio.resume().catch(() => {})
    const samples = new Float32Array(analyser.fftSize)
    const levels: number[] = []
    const color = view.getComputedStyle(canvas).color
    let frame = 0
    let last = 0
    const tick = (now: number) => {
      frame = view.requestAnimationFrame(tick)
      if (now - last < 60) return
      last = now
      analyser.getFloatTimeDomainData(samples)
      let sum = 0
      for (const sample of samples) sum += sample * sample
      // The square root of the RMS follows loudness better, so quiet speech still moves the bars.
      levels.push(Math.min(1, Math.sqrt(Math.sqrt(sum / samples.length)) * 1.8))
      const ratio = view.devicePixelRatio || 1
      const width = Math.round(canvas.clientWidth * ratio)
      const height = Math.round(canvas.clientHeight * ratio)
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width
        canvas.height = height
      }
      const bar = 2 * ratio
      const step = 4 * ratio
      const count = Math.max(1, Math.floor(width / step))
      if (levels.length > count) levels.splice(0, levels.length - count)
      draw.clearRect(0, 0, width, height)
      draw.fillStyle = color
      levels.forEach((level, index) => {
        const barHeight = Math.max(bar, level * height)
        draw.beginPath()
        draw.roundRect(width - (levels.length - index) * step, (height - barHeight) / 2, bar, barHeight, bar / 2)
        draw.fill()
      })
    }
    frame = view.requestAnimationFrame(tick)
    return () => {
      view.cancelAnimationFrame(frame)
      source.disconnect()
      void audio.close().catch(() => {})
    }
  }, [stream])

  return <canvas ref={canvasRef} aria-hidden className={className} />
}

/** Elapsed recording time as m:ss. */
export function RecordingClock({ startedAt, className }: { startedAt: number; className?: string }) {
  const [now, setNow] = useState(startedAt)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(timer)
  }, [])
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000))
  return (
    <span aria-hidden className={className}>
      {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
    </span>
  )
}
