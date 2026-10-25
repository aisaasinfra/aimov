// 站内 /changelog 的条目。published 为 false 的不公开，也不进 llms.txt。
// 文案按语言写在这里，不进 content/en.ts：发版说明和界面文案分开改。
import type { Locale } from '#/config/site'

export type ChangelogEntry = {
  version: string
  date: string
  published?: boolean
  title: Record<Locale, string>
  summary: Record<Locale, string>
  items: Record<Locale, string[]>
}

export type ChangelogView = {
  version: string
  date: string
  title: string
  summary: string
  items: string[]
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: '2026.10.25',
    date: '2026-10-25',
    title: {
      en: 'Waitlist, feedback, and a public changelog',
      zh: '等待列表、产品反馈和站内更新日志',
    },
    summary: {
      en: 'You can leave an email without creating an account, send product feedback after signing in with Google, and read what shipped on this page.',
      zh: '可以只留邮箱、不建账号；用 Google 登录后提交产品反馈；这一页能看到最近上线了什么。',
    },
    items: {
      en: [
        'Public waitlist with bot check when Turnstile is configured, plus an admin list and CSV export.',
        'Signed-in product feedback with statuses open, planned, shipped, and closed. Separate from contact and takedown.',
        'This changelog in English and Chinese, and llms.txt for answer engines.',
        'Optional error reporting stays off until a Sentry-compatible DSN is set.',
      ],
      zh: [
        '公开等待列表：配置了 Turnstile 时会做人机校验；后台可看名单并导出 CSV。',
        '登录后的产品反馈，状态为待处理、已计划、已上线、已关闭，和联系表单、举报下架分开。',
        '本页提供中英文更新说明，并增加供问答引擎读取的 llms.txt。',
        '可选的错误上报：不填 DSN 就保持关闭。',
      ],
    },
  },
  {
    version: '2026.10.25-video',
    date: '2026-10-25',
    title: {
      en: 'Christmas video landing, PayPal.cn packs, NanoAPI',
      zh: '圣诞视频首页、PayPal.cn 积分包和 NanoAPI',
    },
    summary: {
      en: 'The home page is a Christmas video product. Credit packs can be paid with PayPal.cn beside Waffo. NanoAPI is an optional video provider.',
      zh: '首页改成圣诞视频产品。积分包可以在 Waffo 之外用 PayPal.cn 支付。NanoAPI 是可选的视频服务商。',
    },
    items: {
      en: [
        'Pick a holiday world, upload one photo, and download a vertical MP4.',
        'PayPal sells credit packs only. Subscriptions stay on Waffo. Dodo and Stripe remain available when configured.',
        'Sign-in is still Google only, including One Tap.',
      ],
      zh: [
        '选一个节日场景，上传一张照片，下载竖屏 MP4。',
        'PayPal 只卖积分包，订阅仍走 Waffo。配置了 Dodo 或 Stripe 时仍可使用。',
        '登录仍只有 Google，包含 One Tap。',
      ],
    },
  },
]

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// 未发布的丢掉；日期不合法的丢掉（避免排序成 NaN）；新的在前。
export function selectChangelog(entries: readonly ChangelogEntry[], locale: Locale): ChangelogView[] {
  return entries
    .filter((entry) => entry.published !== false && DATE_RE.test(entry.date))
    .slice()
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.version.localeCompare(a.version)))
    .map((entry) => ({
      version: entry.version,
      date: entry.date,
      title: entry.title[locale],
      summary: entry.summary[locale],
      items: entry.items[locale],
    }))
}

export function latestChangelogDate(entries: readonly ChangelogEntry[] = CHANGELOG) {
  return selectChangelog(entries, 'en')[0]?.date ?? null
}
