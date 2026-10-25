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
      de: 'Warteliste, Feedback und ein öffentliches Änderungsprotokoll',
      es: 'Lista de espera, comentarios y un registro público',
      fr: 'Liste d’attente, retours et journal public',
      'pt-BR': 'Lista de espera, feedback e um registro público',
      'zh-TW': '等候名單、產品回饋和站內更新日誌',
    },
    summary: {
      en: 'You can leave an email without creating an account, send product feedback after signing in with Google, and read what shipped on this page.',
      de: 'Du kannst eine E-Mail hinterlassen, ohne ein Konto anzulegen, nach der Google-Anmeldung Produktfeedback senden und hier nachlesen, was neu ist.',
      es: 'Puedes dejar un correo sin crear una cuenta, enviar comentarios del producto tras iniciar sesión con Google y leer aquí lo que se publicó.',
      fr: 'Vous pouvez laisser un e-mail sans créer de compte, envoyer un retour produit après la connexion Google et lire ici ce qui a été livré.',
      'pt-BR': 'Dá para deixar um e-mail sem criar conta, enviar feedback do produto depois do login com Google e ler nesta página o que saiu.',
      'zh-TW': '可以只留電子郵件、不建帳號；用 Google 登入後送出產品回饋；這一頁看得到最近上線了什麼。',
    },
    items: {
      en: [
        'Public waitlist with bot check when Turnstile is configured, plus an admin list and CSV export.',
        'Signed-in product feedback with statuses open, planned, shipped, and closed. Separate from contact and takedown.',
        'This changelog in six languages, and llms.txt for answer engines.',
        'Optional error reporting stays off until a Sentry-compatible DSN is set.',
      ],
      de: [
        'Öffentliche Warteliste mit Bot-Prüfung, wenn Turnstile konfiguriert ist, plus Admin-Liste und CSV-Export.',
        'Produktfeedback nach der Anmeldung, mit den Status offen, geplant, veröffentlicht und geschlossen. Getrennt von Kontakt und Meldungen.',
        'Dieses Protokoll in sechs Sprachen und llms.txt für Antwortmaschinen.',
        'Optionale Fehlermeldung bleibt aus, bis eine Sentry-kompatible DSN gesetzt ist.',
      ],
      es: [
        'Lista de espera pública con comprobación antibots si Turnstile está configurado, más lista de administración y exportación CSV.',
        'Comentarios del producto con sesión iniciada y estados abierto, planificado, publicado y cerrado. Separados del contacto y de las retiradas.',
        'Este registro en seis idiomas y llms.txt para motores de respuesta.',
        'El informe de errores opcional permanece apagado hasta que haya un DSN compatible con Sentry.',
      ],
      fr: [
        'Liste d’attente publique avec contrôle anti-bot si Turnstile est configuré, plus liste d’administration et export CSV.',
        'Retours produit une fois connecté, avec les statuts ouvert, prévu, livré et fermé. Séparés du contact et des signalements.',
        'Ce journal en six langues, et llms.txt pour les moteurs de réponse.',
        'Le signalement d’erreurs facultatif reste désactivé tant qu’un DSN compatible Sentry n’est pas défini.',
      ],
      'pt-BR': [
        'Lista de espera pública com verificação antibot quando o Turnstile está configurado, além da lista no admin e exportação CSV.',
        'Feedback do produto depois do login, com status aberto, planejado, publicado e fechado. Separado de contato e denúncias.',
        'Este registro em seis idiomas e llms.txt para mecanismos de resposta.',
        'O relatório opcional de erros fica desligado até haver um DSN compatível com Sentry.',
      ],
      'zh-TW': [
        '公開等候名單：設定了 Turnstile 時會做人機驗證；後台可看名單並匯出 CSV。',
        '登入後的產品回饋，狀態為待處理、已規劃、已上線、已關閉，和聯絡表單、檢舉下架分開。',
        '本頁提供六種語言的更新說明，並有供問答引擎讀取的 llms.txt。',
        '可選的錯誤回報：不填 DSN 就保持關閉。',
      ],
    },
  },
  {
    version: '2026.10.25-video',
    date: '2026-10-25',
    title: {
      en: 'Christmas video landing, PayPal.cn packs, NanoAPI',
      de: 'Weihnachtsvideo-Startseite, PayPal.cn-Pakete, NanoAPI',
      es: 'Portada de video navideño, paquetes PayPal.cn y NanoAPI',
      fr: 'Page d’accueil vidéo de Noël, packs PayPal.cn et NanoAPI',
      'pt-BR': 'Página de vídeo de Natal, pacotes PayPal.cn e NanoAPI',
      'zh-TW': '聖誕影片首頁、PayPal.cn 點數包和 NanoAPI',
    },
    summary: {
      en: 'The home page is a Christmas video product. Credit packs can be paid with PayPal.cn beside Waffo. NanoAPI is an optional video provider.',
      de: 'Die Startseite ist ein Weihnachtsvideo. Credit-Pakete kannst du neben Waffo mit PayPal.cn bezahlen. NanoAPI ist ein optionaler Videoanbieter.',
      es: 'La portada es un producto de video navideño. Los paquetes de créditos se pueden pagar con PayPal.cn además de Waffo. NanoAPI es un proveedor de video opcional.',
      fr: 'La page d’accueil est un produit de vidéo de Noël. Les packs de crédits peuvent être payés avec PayPal.cn en plus de Waffo. NanoAPI est un fournisseur vidéo facultatif.',
      'pt-BR': 'A página inicial é um produto de vídeo de Natal. Pacotes de crédito podem ser pagos com PayPal.cn além do Waffo. NanoAPI é um provedor de vídeo opcional.',
      'zh-TW': '首頁改成聖誕影片產品。點數包可以在 Waffo 之外用 PayPal.cn 付款。NanoAPI 是可選的影片服務。',
    },
    items: {
      en: [
        'Pick a holiday world, upload one photo, and download a vertical MP4.',
        'PayPal sells credit packs only. Subscriptions stay on Waffo. Dodo and Stripe remain available when configured.',
        'Sign-in is still Google only, including One Tap.',
      ],
      de: [
        'Wähle eine Weihnachtswelt, lade ein Foto hoch und lade ein vertikales MP4 herunter.',
        'PayPal verkauft nur Credit-Pakete. Abos bleiben bei Waffo. Dodo und Stripe bleiben verfügbar, wenn sie konfiguriert sind.',
        'Die Anmeldung ist weiter nur Google, einschließlich One Tap.',
      ],
      es: [
        'Elige un mundo navideño, sube una foto y descarga un MP4 vertical.',
        'PayPal solo vende paquetes de créditos. Las suscripciones siguen en Waffo. Dodo y Stripe siguen disponibles si están configurados.',
        'El inicio de sesión sigue siendo solo Google, incluido One Tap.',
      ],
      fr: [
        'Choisissez un monde de fêtes, envoyez une photo et téléchargez un MP4 vertical.',
        'PayPal ne vend que des packs de crédits. Les abonnements restent sur Waffo. Dodo et Stripe restent disponibles s’ils sont configurés.',
        'La connexion reste Google uniquement, y compris One Tap.',
      ],
      'pt-BR': [
        'Escolha um mundo de Natal, envie uma foto e baixe um MP4 vertical.',
        'O PayPal só vende pacotes de crédito. Assinaturas continuam no Waffo. Dodo e Stripe seguem disponíveis quando configurados.',
        'O login continua só com Google, inclusive One Tap.',
      ],
      'zh-TW': [
        '選一個節日場景，上傳一張照片，下載直式 MP4。',
        'PayPal 只賣點數包，訂閱仍走 Waffo。設定了 Dodo 或 Stripe 時仍可使用。',
        '登入仍只有 Google，包含 One Tap。',
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
