import { describe, expect, it } from 'vitest'
import {
  antigravityApiErrorText,
  antigravityErrorMessage,
  createAntigravityApiFailureHold,
} from '../../src/main/chat/antigravity-subscription/errors'

describe('Antigravity API failure text', () => {
  it('reads the bare messages the server sends for a rejected model call', () => {
    expect(antigravityApiErrorText('Request contains an invalid argument.')).toMatchObject({
      status: 'INVALID_ARGUMENT',
      message: 'Request contains an invalid argument.',
    })
    expect(antigravityApiErrorText(' Internal error encountered.\n')).toMatchObject({ status: 'INTERNAL' })
    expect(
      antigravityApiErrorText('The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).')
    ).toMatchObject({ status: 'TOKEN_LIMIT' })
    expect(
      antigravityApiErrorText(
        'The caller does not have permission\n\nVerify your account: https://accounts.google.com/x'
      )
    ).toMatchObject({ status: 'PERMISSION_DENIED' })
    expect(
      antigravityApiErrorText('Request had invalid authentication credentials. Expected OAuth 2 ...')
    ).toMatchObject({ status: 'UNAUTHENTICATED' })
  })

  it('keeps the reset time of the server quota notice', () => {
    const error = antigravityApiErrorText(
      'Usage Limit Reached\n\nYou have reached your current quota for this period. Your limit will reset in 2 hours.'
    )
    expect(error).toMatchObject({ status: 'RESOURCE_EXHAUSTED' })
    expect(antigravityErrorMessage(error).message).toBe(
      'Google AI usage limit reached for this model. Wait for the limit to reset or choose another model. Your limit will reset in 2 hours.'
    )
  })

  it('does not read ordinary text as a failure', () => {
    expect(antigravityApiErrorText('Request contains an invalid argument. Fix the schema.')).toBeNull()
    expect(antigravityApiErrorText('Request contains an invalid argument.\n\nThe docs say so.\n\nMore.')).toBeNull()
    expect(antigravityApiErrorText('Request contains an invalid argument.\n\nhttp://example.com')).toBeNull()
    expect(antigravityApiErrorText('Done.')).toBeNull()
  })

  it('explains a rejected request instead of showing the bare message', () => {
    expect(antigravityErrorMessage(antigravityApiErrorText('Request contains an invalid argument.')).message).toBe(
      'Google AI rejected this request as invalid (400 INVALID_ARGUMENT: "Request contains an invalid argument."). ' +
        "The error comes from Google's servers, not from Maestrly. Send the message again; if it keeps failing, choose another model or reasoning level."
    )
    expect(
      antigravityErrorMessage(antigravityApiErrorText('Request had invalid authentication credentials.')).message
    ).toMatch(/sign-in is missing or expired/)
  })

  it('holds a failure until something continues the turn', () => {
    const hold = createAntigravityApiFailureHold<string>()
    expect(hold.hold('partial answer', 'a')).toBe(false)
    expect(hold.hold('Internal error encountered.', 'b')).toBe(true)
    expect(hold.release()).toBe('b')
    expect(hold.settle()).toBeNull()
    expect(hold.hold('Internal error encountered.', 'c')).toBe(true)
    expect(hold.settle()).toMatchObject({ status: 'INTERNAL' })
    expect(hold.release()).toBeNull()
  })
})
