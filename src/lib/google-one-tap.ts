/**
 * Google Identity Services One Tap 的开关和关闭记忆。
 *
 * 登录按钮还在。这里只决定什么时候可以弹出，以及访客关掉之后如何记住。
 * id_token 仍交给已有的 `/api/auth/google/one-tap`：服务端核对 nonce、验签、写原来的会话。
 * 不另建一套用户存储。`auto_select` 保持关闭。
 */

export const GOOGLE_GSI_SCRIPT_SRC = 'https://accounts.google.com/gsi/client'

/** 当前标签页。关掉提示后，同标签页里的下一次导航不再弹。 */
export const ONE_TAP_DISMISS_KEY = 'aimov.google-one-tap.dismissed'

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

function browserSessionStorage(): StorageLike | null {
  try {
    if (typeof sessionStorage === 'undefined') return null
    return sessionStorage
  } catch {
    return null
  }
}

export function isOneTapDismissed(storage?: StorageLike | null): boolean {
  try {
    const target = storage === undefined ? browserSessionStorage() : storage
    return target?.getItem(ONE_TAP_DISMISS_KEY) === '1'
  } catch {
    return false
  }
}

export function rememberOneTapDismissed(storage?: StorageLike | null): void {
  try {
    const target = storage === undefined ? browserSessionStorage() : storage
    target?.setItem(ONE_TAP_DISMISS_KEY, '1')
  } catch {
    // 隐私模式可能抛错。下次整页加载可能再弹。
  }
}

export interface OneTapPromptNotification {
  isDismissedMoment?: () => boolean
  getDismissedReason?: () => string
  isSkippedMoment?: () => boolean
  getSkippedReason?: () => string
  isNotDisplayed?: () => boolean
  getNotDisplayedReason?: () => string
}

/**
 * 访客主动关掉提示时返回原因，否则返回 null。
 *
 * Google 自己的“未展示”（没有 Google 会话、被 Google 冷却、浏览器不支持）不是关闭，
 * 下次整页加载还可以再试。`credential_returned` 是成功，不记成关闭。
 */
export function oneTapCloseReason(notification: OneTapPromptNotification | undefined): string | null {
  if (!notification) return null

  if (notification.isSkippedMoment?.()) {
    const reason = notification.getSkippedReason?.() ?? ''
    if (reason === 'user_cancel' || reason === 'tap_outside') return reason
    return null
  }

  if (notification.isDismissedMoment?.()) {
    const reason = notification.getDismissedReason?.() ?? ''
    if (reason === 'cancel_called') return reason
    return null
  }

  return null
}
