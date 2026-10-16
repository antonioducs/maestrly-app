import type { FleetTranscriptItem } from '@maestrly/bot-fleet-protocol'
import { useState } from 'react'
import { Pressable, View } from 'react-native'
import { useI18n } from '../../i18n'
import { useTheme } from '../../theme/ThemeProvider'
import { Icon } from '../icons'
import { Button } from '../primitives/Button'
import { AppText } from '../primitives/Text'
import { CardError, CueCard, ResolvedLine, useResolver } from './CueCard'

export function QuestionCard({ item }: { item: Extract<FleetTranscriptItem, { kind: 'question' }> }) {
  const { palette } = useTheme()
  const { t } = useI18n()
  const { busy, error, run, disabled } = useResolver(item)
  const [index, setIndex] = useState(0)
  const [answers, setAnswers] = useState<string[][]>(() => item.questions.map(() => []))

  if (item.state === 'answered')
    return (
      <ResolvedLine
        icon="check"
        tone="ok"
        text={t('question.answered', { answer: (item.answers ?? []).flat().join(', ') })}
      />
    )
  if (item.state === 'dismissed') return <ResolvedLine icon="x" tone="muted" text={t('question.dismissed')} />
  const question = item.questions[index]
  if (!question) return null
  const chosen = answers[index] ?? []
  const last = index === item.questions.length - 1

  const toggle = (label: string) =>
    setAnswers((current) =>
      current.map((list, at) =>
        at !== index
          ? list
          : question.multiSelect
            ? list.includes(label)
              ? list.filter((value) => value !== label)
              : [...list, label]
            : [label]
      )
    )

  return (
    <CueCard>
      {item.questions.length > 1 ? (
        <AppText variant="small" tone="muted" style={{ marginBottom: 4 }}>
          {t('question.progress', { index: index + 1, total: item.questions.length })}
        </AppText>
      ) : null}
      <AppText accessibilityRole="header" style={{ fontSize: 17, lineHeight: 22, fontWeight: '600', marginBottom: 10 }}>
        {question.question}
      </AppText>
      <View accessibilityRole={question.multiSelect ? undefined : 'radiogroup'} style={{ gap: 8, marginBottom: 12 }}>
        {question.options.map((option) => {
          const selected = chosen.includes(option.label)
          return (
            <Pressable
              key={option.label}
              accessibilityRole={question.multiSelect ? 'checkbox' : 'radio'}
              aria-checked={selected}
              aria-disabled={disabled}
              accessibilityLabel={option.description ? `${option.label}, ${option.description}` : option.label}
              disabled={disabled}
              onPress={() => toggle(option.label)}
              style={{
                flexDirection: 'row',
                gap: 10,
                paddingVertical: 10,
                paddingHorizontal: 12,
                borderRadius: 12,
                borderWidth: selected ? 2 : 1,
                borderColor: selected ? palette.ink : palette.line,
                backgroundColor: palette.raised,
                opacity: disabled && !busy ? 0.6 : 1,
              }}
            >
              <View
                style={{
                  width: 20,
                  height: 20,
                  marginTop: 1,
                  borderRadius: question.multiSelect ? 6 : 10,
                  borderWidth: selected ? (question.multiSelect ? 0 : 6) : 1.5,
                  borderColor: selected ? palette.ink : palette.lineStrong,
                  backgroundColor: selected && question.multiSelect ? palette.ink : palette.raised,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {selected && question.multiSelect ? (
                  <Icon name="check" size={14} color={palette.raised} strokeWidth={2.4} />
                ) : null}
              </View>
              <View style={{ flex: 1 }}>
                <AppText style={{ fontSize: 15, lineHeight: 20, fontWeight: '600' }}>{option.label}</AppText>
                {option.description ? (
                  <AppText variant="sub" tone="muted" style={{ lineHeight: 18 }}>
                    {option.description}
                  </AppText>
                ) : null}
              </View>
            </Pressable>
          )
        })}
      </View>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Button
          label={last ? t('question.send') : t('common.continue')}
          style={{ flex: 1 }}
          disabled={disabled || chosen.length === 0}
          busy={busy}
          onPress={() =>
            last ? void run({ kind: 'question', answers }, t('announce.answered')) : setIndex((value) => value + 1)
          }
        />
        <Button
          label={t('question.skip')}
          variant="ghost"
          disabled={disabled}
          onPress={() => void run({ kind: 'question_dismiss' }, t('question.dismissed'))}
        />
      </View>
      <CardError text={error} />
    </CueCard>
  )
}
