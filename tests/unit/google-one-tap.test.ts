import { describe, expect, it } from 'vitest'
import {
  ONE_TAP_DISMISS_KEY,
  isOneTapDismissed,
  oneTapCloseReason,
  rememberOneTapDismissed,
  type OneTapPromptNotification,
} from '#/lib/google-one-tap'

function memoryStorage(initial?: Record<string, string>) {
  const data = new Map(Object.entries(initial ?? {}))
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value)
    },
  }
}

function skipped(reason: string): OneTapPromptNotification {
  return { isSkippedMoment: () => true, getSkippedReason: () => reason }
}

function dismissed(reason: string): OneTapPromptNotification {
  return { isDismissedMoment: () => true, getDismissedReason: () => reason }
}

describe('One Tap 关闭记忆', () => {
  it('只有访客关掉才算关闭，成功和未展示都不算', () => {
    expect(oneTapCloseReason(skipped('user_cancel'))).toBe('user_cancel')
    expect(oneTapCloseReason(skipped('tap_outside'))).toBe('tap_outside')
    expect(oneTapCloseReason(skipped('auto_cancel'))).toBeNull()
    expect(oneTapCloseReason(skipped('issuing_failed'))).toBeNull()
    expect(oneTapCloseReason(dismissed('cancel_called'))).toBe('cancel_called')
    expect(oneTapCloseReason(dismissed('credential_returned'))).toBeNull()
    expect(oneTapCloseReason(dismissed('flow_restarted'))).toBeNull()
    expect(oneTapCloseReason({ isNotDisplayed: () => true, getNotDisplayedReason: () => 'opt_out_or_no_session' })).toBeNull()
    expect(oneTapCloseReason(undefined)).toBeNull()
  })

  it('关闭写进传入的存储，下次读取为已关闭', () => {
    const storage = memoryStorage()
    expect(isOneTapDismissed(storage)).toBe(false)
    rememberOneTapDismissed(storage)
    expect(storage.getItem(ONE_TAP_DISMISS_KEY)).toBe('1')
    expect(isOneTapDismissed(storage)).toBe(true)
  })

  it('存储抛错时当成没关闭，也不把异常抛出去', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    expect(isOneTapDismissed(broken)).toBe(false)
    expect(() => rememberOneTapDismissed(broken)).not.toThrow()
  })
})
