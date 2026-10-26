import { useRouterState } from '@tanstack/react-router'
import { useState } from 'react'
import { site } from '#/config/site'
import { api, errorCode } from '#/lib/api'
import { track } from '#/lib/attribution'
import { useLocale, useLocalePath } from '#/lib/i18n'
import { signInHref, useSession } from '#/lib/session'

// 价格页、生成器和播放器共用的下单：未登录跳登录，已登录 POST /api/checkout 后跳收银台。
// channel 只在价格页的 Waffo / PayPal 选择器里传。生成器里买够用的积分包时走服务端默认通道。
export function useCheckout() {
  const locale = useLocale()
  const lp = useLocalePath()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const { user, config, loading } = useSession()
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // 暂停说明给所有人看；按钮只对管理员保持可点，便于验证
  const checkoutPaused = !!config?.notice.checkoutPaused
  const paused = checkoutPaused && user?.role !== 'admin'

  async function buy(packageId: string, channel?: string) {
    if (!user) {
      location.href = signInHref(config, pathname, lp('/sign-in'))
      return
    }
    setError(null)
    setPending(packageId)
    const pack = site.packages.find((item) => item.id === packageId) ?? site.plans.find((item) => item.id === packageId)
    if (pack) {
      track('begin_checkout', {
        value: pack.priceCents / 100,
        currency: pack.currency,
        items: [{ item_id: pack.id, item_name: pack.id, quantity: 1 }],
      })
    }
    try {
      const data = await api<{ orderId: string; url: string }>('/api/checkout', {
        json: { packageId, locale, ...(channel ? { channel } : {}) },
      })
      location.href = data.url
    } catch (err) {
      setError(errorCode(err))
      setPending(null)
    }
  }

  return { buy, pending, error, checkoutPaused, paused, loading, user }
}
