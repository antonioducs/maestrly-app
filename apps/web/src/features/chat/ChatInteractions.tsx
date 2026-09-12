import { useState } from 'react'
import type { ChatDecision, ProjectChatInteraction } from '@maestrly/protocol'
import { Markdown } from '../../components/Markdown.js'
import { t } from '../../i18n/index.js'
function Interaction({
  item,
  busy,
  onDecide,
}: {
  item: ProjectChatInteraction
  busy: boolean
  onDecide(decision: ChatDecision): void
}) {
  const p = item.payload
  const [answers, setAnswers] = useState<string[]>(() => (p.type === 'question' ? p.questions.map(() => '') : []))
  const [choices, setChoices] = useState<string[][]>(() => (p.type === 'question' ? p.questions.map(() => []) : []))
  const [plan, setPlan] = useState(p.type === 'plan' ? p.plan : ''),
    [feedback, setFeedback] = useState(''),
    [editing, setEditing] = useState(false)
  return (
    <section
      className="project-chat-interaction"
      aria-label={t(
        p.type === 'plan' ? 'Plan review' : p.type === 'question' ? 'Agent question' : 'Permission request'
      )}
    >
      {p.type === 'permission' ? (
        <>
          <h3>{t('Permission request')}</h3>
          <p>{p.title}</p>
          <pre>{p.resources.join('\n')}</pre>
          <div className="dialog-actions">
            <button className="quiet" disabled={busy} onClick={() => onDecide({ type: 'permission', reply: 'reject' })}>
              {t('Reject')}
            </button>
            <button className="primary" disabled={busy} onClick={() => onDecide({ type: 'permission', reply: 'once' })}>
              {t('Allow once')}
            </button>
          </div>
        </>
      ) : null}
      {p.type === 'question' ? (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            onDecide({
              type: 'question',
              answers: answers.map((answer, i) => [...choices[i], ...(answer.trim() ? [answer.trim()] : [])]),
            })
          }}
        >
          <h3>{t('Agent question')}</h3>
          {p.questions.map((q, index) => (
            <fieldset key={index}>
              <legend>{q.question}</legend>
              {q.options.map((option) => (
                <label className="chat-choice" key={option.label}>
                  <input
                    type={q.multiple ? 'checkbox' : 'radio'}
                    name={'question-' + index}
                    checked={choices[index].includes(option.label)}
                    onChange={() =>
                      setChoices((current) =>
                        current.map((v, i) =>
                          i !== index
                            ? v
                            : q.multiple
                              ? v.includes(option.label)
                                ? v.filter((x) => x !== option.label)
                                : [...v, option.label]
                              : [option.label]
                        )
                      )
                    }
                  />
                  <span>
                    {option.label}
                    {option.description ? <small>{option.description}</small> : null}
                  </span>
                </label>
              ))}
              <label>
                {t('Your response')}
                <textarea
                  rows={2}
                  value={answers[index]}
                  onChange={(e) => setAnswers((current) => current.map((v, i) => (i === index ? e.target.value : v)))}
                />
              </label>
            </fieldset>
          ))}
          <button className="primary" disabled={busy || answers.some((v, i) => !v.trim() && !choices[i].length)}>
            {t('Send response')}
          </button>
        </form>
      ) : null}
      {p.type === 'plan' ? (
        <>
          <h3>{p.title}</h3>
          {editing ? (
            <label>
              {t('Edit plan')}
              <textarea rows={12} value={plan} onChange={(e) => setPlan(e.target.value)} />
            </label>
          ) : (
            <Markdown value={plan} />
          )}
          <button className="quiet" onClick={() => setEditing(!editing)}>
            {t(editing ? 'Preview' : 'Edit plan')}
          </button>
          <label>
            {t('Feedback')}
            <textarea rows={2} value={feedback} onChange={(e) => setFeedback(e.target.value)} />
          </label>
          <div className="dialog-actions">
            <button className="quiet" disabled={busy} onClick={() => onDecide({ type: 'plan', action: 'discard' })}>
              {t('Discard plan')}
            </button>
            <button
              className="quiet"
              disabled={busy || !feedback.trim()}
              onClick={() => onDecide({ type: 'plan', action: 'revise', feedback })}
            >
              {t('Request changes')}
            </button>
            <button
              className="primary"
              disabled={busy || !plan.trim()}
              onClick={() => onDecide({ type: 'plan', action: 'approve', editedPlan: plan })}
            >
              {t('Approve plan')}
            </button>
          </div>
        </>
      ) : null}
    </section>
  )
}
export function ChatInteractions({
  items,
  busy,
  onDecide,
}: {
  items: ProjectChatInteraction[]
  busy: boolean
  onDecide(item: ProjectChatInteraction, decision: ChatDecision): void
}) {
  return (
    <>
      {items
        .filter((i) => i.state === 'pending')
        .map((item) => (
          <Interaction key={item.id + ':' + item.version} item={item} busy={busy} onDecide={(d) => onDecide(item, d)} />
        ))}
    </>
  )
}
