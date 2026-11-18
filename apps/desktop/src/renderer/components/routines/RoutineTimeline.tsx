import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { LocalRoutine, LocalRoutineRun } from '../../../shared/routines'
import { buildTimelineData } from '@/lib/routines/timeline'
import { scheduleSummary } from '@/lib/routines/schedule-text'
import { cn } from '@/lib/utils'

interface TipState {
  x: number
  y: number
  title: string
  sub: string
}

export function RoutineTimeline({
  routines,
  runsByRoutine,
  single = false,
  nowMs: propNowMs,
  onOpenRoutine,
  onOpenRun,
}: {
  routines: readonly LocalRoutine[]
  runsByRoutine: Record<string, readonly LocalRoutineRun[]>
  single?: boolean
  nowMs?: number
  onOpenRoutine: (routineId: string) => void
  onOpenRun: (routineId: string, runId: string) => void
}) {
  const { t } = useTranslation('routines')
  const nowMs = propNowMs ?? Date.now()
  const tr = (key: string, opts?: Record<string, unknown>): string => String(t(key as never, opts as never))
  const data = useMemo(
    () => buildTimelineData(routines, runsByRoutine, nowMs, tr),
    [routines, runsByRoutine, nowMs, t]
  )
  const scrollRef = useRef<HTMLDivElement>(null)
  const [tip, setTip] = useState<TipState | null>(null)

  useEffect(() => {
    const scroller = scrollRef.current
    if (!scroller || scroller.scrollWidth <= scroller.clientWidth) return
    const nameEl = scroller.querySelector<HTMLElement>('.routine-tl-name')
    const nameW = nameEl?.offsetWidth ?? 176
    const trackX = (data.nowPct / 100) * (scroller.scrollWidth - nameW)
    scroller.scrollLeft = Math.max(0, trackX - (scroller.clientWidth - nameW) * 0.25)
  }, [data.nowPct, routines.length])

  const showTip = (target: HTMLElement, title: string, sub: string) => {
    const r = target.getBoundingClientRect()
    const x = Math.max(12, Math.min(window.innerWidth - 292, r.left + r.width / 2 - 90))
    const y = Math.max(12, r.top - 48)
    setTip({ x, y, title, sub })
  }
  const hideTip = () => setTip(null)

  const cornerLabel = single
    ? t('timeline.thisWeek')
    : t(routines.length === 1 ? 'timeline.routineCountSingle' : 'timeline.routineCountPlural', {
        count: routines.length,
      })

  return (
    <div className="routine-tl">
      <div ref={scrollRef} className="routine-tl-scroll">
        <div className="routine-tl-inner">
          <div className="routine-tl-head">
            <span className="routine-tl-corner">{cornerLabel}</span>
            <div className="routine-tl-days">
              {data.days.map((day, idx) => (
                <span
                  key={idx}
                  className={cn('routine-tl-day', day.isToday && 'is-today')}
                  style={{ left: `${day.leftPct}%` }}
                >
                  {day.label}
                </span>
              ))}
            </div>
          </div>

          <div className="routine-tl-overlay">
            <div className="routine-tl-past" style={{ width: `${data.nowPct}%` }} />
            {data.nights.map((night, idx) => (
              <div
                key={idx}
                className="routine-tl-night"
                style={{ left: `${night.leftPct}%`, width: `${night.widthPct}%` }}
              />
            ))}
            {data.separators.map((leftPct, idx) => (
              <div key={idx} className="routine-tl-sep" style={{ left: `${leftPct}%` }} />
            ))}
            <div className="routine-tl-now" style={{ left: `${data.nowPct}%` }} data-label={data.nowLabel} />
          </div>

          {data.rows.map((row) => {
            const summary = scheduleSummary(row.routine.schedule, tr)
            return (
              <div
                key={row.routine.id}
                className={cn('routine-tl-row', !row.routine.enabled && 'is-paused', single && 'is-single')}
              >
                {single ? (
                  <div className="routine-tl-name cursor-default">
                    <b>{row.routine.schedule.kind === 'weekly' ? t('timeline.fixedSchedule') : t('timeline.interval')}</b>
                    <span>{summary}</span>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="routine-tl-name"
                    onClick={() => onOpenRoutine(row.routine.id)}
                  >
                    <b>{row.routine.title}</b>
                    <span>{summary}</span>
                  </button>
                )}

                <div className="routine-tl-track">
                  {row.pastTicks.map((tick) =>
                    tick.skipped ? (
                      <span
                        key={tick.run.id}
                        className={cn('routine-tick', row.useBars && 'is-bar', `routine-tone-${tick.tone}`)}
                        style={{ left: tick.leftStyle }}
                        onMouseEnter={(e) => showTip(e.currentTarget, tick.tip, tick.tipSub)}
                        onMouseLeave={hideTip}
                      />
                    ) : (
                      <button
                        key={tick.run.id}
                        type="button"
                        className={cn('routine-tick', row.useBars && 'is-bar', `routine-tone-${tick.tone}`)}
                        style={{ left: tick.leftStyle }}
                        aria-label={tick.ariaLabel}
                        tabIndex={row.useBars ? -1 : 0}
                        onClick={() => onOpenRun(row.routine.id, tick.run.id)}
                        onMouseEnter={(e) => showTip(e.currentTarget, tick.tip, tick.tipSub)}
                        onMouseLeave={hideTip}
                        onFocus={(e) => showTip(e.currentTarget, tick.tip, tick.tipSub)}
                        onBlur={hideTip}
                      />
                    )
                  )}

                  {row.futureTicks.map((tick, idx) => (
                    <span
                      key={idx}
                      className={cn('routine-tick is-future', row.useBars && 'is-bar')}
                      style={{ left: tick.leftStyle }}
                      onMouseEnter={(e) => showTip(e.currentTarget, tick.tip, tick.tipSub)}
                      onMouseLeave={hideTip}
                    />
                  ))}

                  {row.pausedFromPct !== null && (
                    <div className="routine-tl-paused" style={{ left: `${row.pausedFromPct}%` }}>
                      {t('timeline.paused')}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <div className="routine-tl-legend">
        <span>
          <i className="routine-tick routine-tone-notable" />
          {t('timeline.legendNotable')}
        </span>
        <span>
          <i className="routine-tick routine-tone-quiet" />
          {t('timeline.legendQuiet')}
        </span>
        <span>
          <i className="routine-tick routine-tone-warn" />
          {t('timeline.legendWaiting')}
        </span>
        <span>
          <i className="routine-tick routine-tone-error" />
          {t('timeline.legendFailed')}
        </span>
        <span>
          <i className="routine-tick routine-tone-skip" />
          {t('timeline.legendSkipped')}
        </span>
        <span>
          <i className="routine-tick is-future" />
          {t('timeline.legendScheduled')}
        </span>
        <span>
          <i className="routine-tl-legend-night" />
          {t('timeline.legendNight')}
        </span>
      </div>

      {tip && (
        <div className="routine-tl-tip" style={{ left: tip.x, top: tip.y }}>
          <b className="block font-semibold">{tip.title}</b>
          {tip.sub && <span className="text-muted-foreground">{tip.sub}</span>}
        </div>
      )}
    </div>
  )
}
