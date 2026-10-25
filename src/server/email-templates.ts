import { DEFAULT_LOCALE, LOCALE_META, isLocale, localePath, site, type Locale } from '#/config/site'
import type { AlertKind } from './alerts'

// 交易邮件模板。用户邮件按公开 LOCALES 各一份（新增语言时类型检查会要求补齐）。
// 管理员邮件仍是运营用简体中文，locale 记成 'zh'，但 'zh' 不在 LOCALES 里，也不会变成站点语言。
// 用户输入（姓名、留言内容等）只出现在正文并全部转义，不进 Subject。

export interface TemplateParams {
  generation_succeeded: { generationId: string; expiresAt: string | null }
  generation_failed: { generationId: string; credits: number }
  order_paid: { orderId: string; credits: number; amount: string }
  takedown_received: { reportId: string; dueAt: string }
  takedown_resolved: { reportId: string; outcome: 'removed' | 'rejected' }
  content_removed: { reportId: string; videos: number }
  admin_takedown: { reportId: string; stage: 'new' | 'due_soon' | 'overdue'; reason: string; generationId: string | null; dueAt: string }
  admin_contact: { messageId: string; topic: string; email: string; message: string }
  // count：异常数量；total：分母（只有失败率有）；windowMinutes：统计窗口（积压为“超过多少分钟未完成”）
  admin_alert: { kind: AlertKind; count: number; total: number | null; windowMinutes: number; detail: string | null }
}

export type EmailTemplate = keyof TemplateParams
type AdminTemplate = 'admin_takedown' | 'admin_contact' | 'admin_alert'
type UserTemplate = Exclude<EmailTemplate, AdminTemplate>

export interface RenderedEmail {
  subject: string
  text: string
  html: string
  replyTo: string
}

type Block = {
  subject: string
  heading: string
  paragraphs: string[]
  cta?: { label: string; url: string }
  footer?: string
  replyTo?: string // 默认 site.supportEmail
}
type Ctx = { siteUrl: string; locale: Locale }
type Render<K extends EmailTemplate> = (p: TemplateParams[K], ctx: Ctx) => Block

const brand = site.brandName

function link(ctx: Ctx, path: string) {
  return `${ctx.siteUrl}${localePath(ctx.locale, path)}`
}

function formatInTag(tag: string, iso: string, withTime = false) {
  return new Intl.DateTimeFormat(tag, {
    dateStyle: 'medium',
    ...(withTime ? { timeStyle: 'short' } : {}),
    timeZone: 'UTC',
  }).format(new Date(iso)) + (withTime ? ' UTC' : '')
}

function date(ctx: Ctx, iso: string, withTime = false) {
  return formatInTag(LOCALE_META[ctx.locale].tag, iso, withTime)
}

// 运营邮件的日期。不走 LOCALE_META，避免为了后台再挂一个简体站点语言。
function operatorDate(iso: string, withTime = false) {
  return formatInTag('zh-CN', iso, withTime)
}

const AI_FOOTER: Record<Locale, string> = {
  en: `Videos made with ${brand} are AI-generated. Please label them as AI when you share them.`,
  de: `Videos von ${brand} sind KI-generiert. Bitte kennzeichne sie beim Teilen als KI.`,
  es: `Los videos de ${brand} están generados por IA. Indícalo cuando los compartas.`,
  fr: `Les vidéos créées avec ${brand} sont générées par IA. Indiquez-le lorsque vous les partagez.`,
  'pt-BR': `Os vídeos feitos com ${brand} são gerados por IA. Avise isso ao compartilhar.`,
  'zh-TW': `${brand} 產生的影片都是 AI 生成，分享時請註明。`,
}

const REASONS_ZH: Record<string, string> = {
  intimate: '私密影像',
  impersonation: '冒用肖像',
  minor: '涉及未成年人',
  copyright: '版权',
  other: '其他',
}

const TOPICS_ZH: Record<string, string> = { general: '一般咨询', billing: '账单', bug: 'Bug', partnership: '合作' }

function span(minutes: number) {
  return minutes % 60 === 0 ? `${minutes / 60} 小时` : `${minutes} 分钟`
}

type AlertParams = TemplateParams['admin_alert']
const ALERTS_ZH: Record<AlertKind, (p: AlertParams) => { title: string; summary: string; hint: string; path: string }> = {
  generation_failures: (p) => ({
    title: `生成失败率 ${Math.round((p.count / (p.total || p.count)) * 100)}%`,
    summary: `最近 ${span(p.windowMinutes)}完成的 ${p.total} 个生成任务中有 ${p.count} 个失败（不含管理员手动失败和举报下架）。失败任务已自动退积分。`,
    hint: '常见原因：视频服务商故障或限流、服务商账户余额不足、API Key 失效。',
    path: '/admin/generations',
  }),
  dead_letter: (p) => ({
    title: `${p.count} 个任务进入死信队列`,
    summary: `最近 ${span(p.windowMinutes)}有 ${p.count} 个生成任务的队列消息重试耗尽，已判失败并退积分。`,
    hint: '说明队列消费者在持续报错（服务商接口异常、R2 读写失败等），请在 Workers 日志里搜索 "video job failed"。',
    path: '/admin/generations',
  }),
  provider_account: (p) => ({
    title: `视频服务商账户异常：${p.count} 个任务失败`,
    summary: `最近 ${span(p.windowMinutes)}有 ${p.count} 个生成任务因服务商账户问题失败（${p.detail ?? ''}），已自动退积分。不处理的话之后的任务都会失败。`,
    hint: '按错误码处理：provider_not_configured 是没配密钥；YIR_UNAUTHORIZED 是密钥失效；YIR_INSUFFICIENT_BALANCE 到 yir 后台充值；YIR_SPEND_LIMIT_EXCEEDED 调高 API Key 的月度额度；nanoapi_invalid_api_key 是 NanoAPI 密钥失效；nanoapi_insufficient_balance 到 NanoAPI 后台充值；nanoapi_account_suspended 是账户被停用，联系 NanoAPI 支持。',
    path: '/admin/generations',
  }),
  job_backlog: (p) => ({
    title: `${p.count} 个任务积压`,
    summary: `${p.count} 个生成任务创建超过 ${span(p.windowMinutes)}仍未完成，超时后会自动判失败并退积分。`,
    hint: '可能是队列消费者没有运行、服务商排队过长，或 Cron 没有触发。',
    path: '/admin/generations',
  }),
  payment_webhook: (p) => ({
    title: `${p.count} 个支付回调处理失败`,
    summary: `最近 ${span(p.windowMinutes)}有 ${p.count} 个支付回调处理失败且没有重放成功，用户可能已付款但积分没到账。`,
    hint: '支付商会自动重试回调；持续失败请在后台“支付事件”页查看错误，修复后到支付商后台重发。',
    path: '/admin/events',
  }),
  payment_review: (p) => ({
    title: `${p.count} 笔付款待人工核对`,
    summary: `最近 ${span(p.windowMinutes)}有 ${p.count} 个付款成功回调没有入账：找不到对应订单，或实收金额、币种、商品和订单不一致。`,
    hint: '在“支付事件”页按状态筛选“孤儿事件”“金额/商品不符”查看原因；核实已付款就在订单页补单，否则到支付商后台退款。',
    path: '/admin/events',
  }),
  email_failures: (p) => ({
    title: `${p.count} 封邮件发送失败`,
    summary: `最近 ${span(p.windowMinutes)}有 ${p.count} 封邮件发送失败或多次重试仍未发出。`,
    hint: '如果是发件域名或配额问题，这封告警本身也可能发不出去，请同时查看 Workers 日志。修复后可在后台“邮件”页重发。',
    path: '/admin/emails',
  }),
  backup_failed: (p) => ({
    title: 'D1 每日备份失败',
    summary: `今天的数据库备份连续 ${p.count} 次失败，今天不再重试：${p.detail ?? ''}`,
    hint: '在 Workers 日志里搜索 "d1 backup failed"。数据库过大导致超时或超内存时，改用 wrangler d1 export 手动导出；D1 Time Travel 仍可恢复 30 天内的任意时刻。',
    path: '/admin',
  }),
}

const USER_TEMPLATES: { [K in UserTemplate]: Record<Locale, Render<K>> } = {
  generation_succeeded: {
    en: (p, ctx) => ({
      subject: `Your ${brand} video is ready`,
      heading: 'Your video is ready',
      paragraphs: [
        'Your AI video is ready to watch and download.',
        p.expiresAt ? `We keep it until ${date(ctx, p.expiresAt)}, then delete it automatically. Download a copy if you want to keep it.` : '',
      ],
      cta: { label: 'Open my videos', url: link(ctx, '/dashboard') },
      footer: AI_FOOTER.en,
    }),
    de: (p, ctx) => ({
      subject: `Dein ${brand}-Video ist fertig`,
      heading: 'Dein Video ist fertig',
      paragraphs: [
        'Dein KI-Video kann jetzt angesehen und heruntergeladen werden.',
        p.expiresAt ? `Wir behalten es bis ${date(ctx, p.expiresAt)} und löschen es danach automatisch. Lade eine Kopie herunter, wenn du es behalten willst.` : '',
      ],
      cta: { label: 'Meine Videos öffnen', url: link(ctx, '/dashboard') },
      footer: AI_FOOTER.de,
    }),
    es: (p, ctx) => ({
      subject: `Tu video de ${brand} está listo`,
      heading: 'Tu video está listo',
      paragraphs: [
        'Tu video de IA ya se puede ver y descargar.',
        p.expiresAt ? `Lo guardamos hasta el ${date(ctx, p.expiresAt)} y después lo borramos. Descarga una copia si quieres conservarlo.` : '',
      ],
      cta: { label: 'Abrir mis videos', url: link(ctx, '/dashboard') },
      footer: AI_FOOTER.es,
    }),
    fr: (p, ctx) => ({
      subject: `Votre vidéo ${brand} est prête`,
      heading: 'Votre vidéo est prête',
      paragraphs: [
        'Votre vidéo générée par IA peut être regardée et téléchargée.',
        p.expiresAt ? `Nous la conservons jusqu’au ${date(ctx, p.expiresAt)}, puis elle est supprimée. Téléchargez une copie si vous voulez la garder.` : '',
      ],
      cta: { label: 'Ouvrir mes vidéos', url: link(ctx, '/dashboard') },
      footer: AI_FOOTER.fr,
    }),
    'pt-BR': (p, ctx) => ({
      subject: `Seu vídeo ${brand} está pronto`,
      heading: 'Seu vídeo está pronto',
      paragraphs: [
        'Seu vídeo de IA já pode ser assistido e baixado.',
        p.expiresAt ? `Guardamos até ${date(ctx, p.expiresAt)} e depois apagamos. Baixe uma cópia se quiser manter.` : '',
      ],
      cta: { label: 'Abrir meus vídeos', url: link(ctx, '/dashboard') },
      footer: AI_FOOTER['pt-BR'],
    }),
    'zh-TW': (p, ctx) => ({
      subject: `你的 ${brand} 影片已產生`,
      heading: '影片已產生',
      paragraphs: ['你的 AI 影片可以觀看和下載了。', p.expiresAt ? `成片保留到 ${date(ctx, p.expiresAt)}，之後會自動刪除；想長期保存請先下載。` : ''],
      cta: { label: '查看我的影片', url: link(ctx, '/dashboard') },
      footer: AI_FOOTER['zh-TW'],
    }),
  },

  generation_failed: {
    en: (p, ctx) => ({
      subject: `Your ${brand} video failed — credits refunded`,
      heading: "We couldn't make your video",
      paragraphs: [
        `Something went wrong while generating your video. We've returned ${p.credits} credits to your balance.`,
        'You can try again with the same photo, or use a clear, front-facing one.',
      ],
      cta: { label: 'Try again', url: link(ctx, '/') },
    }),
    de: (p, ctx) => ({
      subject: `Dein ${brand}-Video ist fehlgeschlagen — Guthaben zurück`,
      heading: 'Das Video konnte nicht erstellt werden',
      paragraphs: [
        `Beim Erstellen ist etwas schiefgelaufen. Wir haben ${p.credits} Credits auf dein Guthaben zurückgebucht.`,
        'Du kannst es mit demselben Foto noch einmal versuchen oder ein klares Frontalfoto verwenden.',
      ],
      cta: { label: 'Erneut versuchen', url: link(ctx, '/') },
    }),
    es: (p, ctx) => ({
      subject: `Tu video de ${brand} falló — créditos devueltos`,
      heading: 'No pudimos crear tu video',
      paragraphs: [
        `Algo falló al generar el video. Devolvimos ${p.credits} créditos a tu saldo.`,
        'Puedes intentarlo con la misma foto o con una de frente, nítida.',
      ],
      cta: { label: 'Intentar de nuevo', url: link(ctx, '/') },
    }),
    fr: (p, ctx) => ({
      subject: `Votre vidéo ${brand} a échoué — crédits recrédités`,
      heading: 'Nous n’avons pas pu créer votre vidéo',
      paragraphs: [
        `Un problème est survenu pendant la génération. Nous avons recrédité ${p.credits} crédits sur votre solde.`,
        'Vous pouvez réessayer avec la même photo, ou avec un portrait net de face.',
      ],
      cta: { label: 'Réessayer', url: link(ctx, '/') },
    }),
    'pt-BR': (p, ctx) => ({
      subject: `Seu vídeo ${brand} falhou — créditos devolvidos`,
      heading: 'Não foi possível criar seu vídeo',
      paragraphs: [
        `Algo deu errado na geração. Devolvemos ${p.credits} créditos ao seu saldo.`,
        'Tente de novo com a mesma foto ou com um retrato nítido de frente.',
      ],
      cta: { label: 'Tentar de novo', url: link(ctx, '/') },
    }),
    'zh-TW': (p, ctx) => ({
      subject: `你的 ${brand} 影片沒有產生，點數已退回`,
      heading: '影片沒有產生',
      paragraphs: [`這次沒有成功，${p.credits} 點已退回你的帳戶。`, '可以用同一張照片再試，或換一張清楚的正面照。'],
      cta: { label: '重新產生', url: link(ctx, '/') },
    }),
  },

  order_paid: {
    en: (p, ctx) => ({
      subject: `${p.credits} credits added to your ${brand} account`,
      heading: 'Credits added',
      paragraphs: [
        `Thanks for your purchase! ${p.credits} credits have been added to your account (order ${p.orderId}, ${p.amount}).`,
        'Your payment receipt is sent separately by our payment provider.',
      ],
      cta: { label: 'Create a video', url: link(ctx, '/') },
    }),
    de: (p, ctx) => ({
      subject: `${p.credits} Credits auf deinem ${brand}-Konto`,
      heading: 'Credits gutgeschrieben',
      paragraphs: [
        `Danke für deinen Kauf. ${p.credits} Credits sind auf deinem Konto (Bestellung ${p.orderId}, ${p.amount}).`,
        'Die Zahlungsquittung schickt unser Zahlungsanbieter separat.',
      ],
      cta: { label: 'Video erstellen', url: link(ctx, '/') },
    }),
    es: (p, ctx) => ({
      subject: `${p.credits} créditos añadidos a tu cuenta de ${brand}`,
      heading: 'Créditos añadidos',
      paragraphs: [
        `Gracias por tu compra. Añadimos ${p.credits} créditos a tu cuenta (pedido ${p.orderId}, ${p.amount}).`,
        'El recibo lo envía por separado nuestro proveedor de pagos.',
      ],
      cta: { label: 'Crear un video', url: link(ctx, '/') },
    }),
    fr: (p, ctx) => ({
      subject: `${p.credits} crédits ajoutés à votre compte ${brand}`,
      heading: 'Crédits ajoutés',
      paragraphs: [
        `Merci pour votre achat. ${p.credits} crédits ont été ajoutés à votre compte (commande ${p.orderId}, ${p.amount}).`,
        'Le reçu de paiement est envoyé séparément par notre prestataire de paiement.',
      ],
      cta: { label: 'Créer une vidéo', url: link(ctx, '/') },
    }),
    'pt-BR': (p, ctx) => ({
      subject: `${p.credits} créditos adicionados à sua conta ${brand}`,
      heading: 'Créditos adicionados',
      paragraphs: [
        `Obrigado pela compra. ${p.credits} créditos entraram na sua conta (pedido ${p.orderId}, ${p.amount}).`,
        'O recibo é enviado à parte pelo processador de pagamento.',
      ],
      cta: { label: 'Criar um vídeo', url: link(ctx, '/') },
    }),
    'zh-TW': (p, ctx) => ({
      subject: `${p.credits} 點已入帳`,
      heading: '點數已入帳',
      paragraphs: [`謝謝購買。${p.credits} 點已加到你的 ${brand} 帳戶（訂單 ${p.orderId}，${p.amount}）。`, '付款收據由金流服務另行寄出。'],
      cta: { label: '開始製作', url: link(ctx, '/') },
    }),
  },

  takedown_received: {
    en: (p, ctx) => ({
      subject: `We received your report (${p.reportId})`,
      heading: 'Report received',
      paragraphs: [
        `Reference: ${p.reportId}. We'll review it by ${date(ctx, p.dueAt, true)} and email you the outcome.`,
        'To add information, such as a link or the file name of the video, reply to this email.',
      ],
    }),
    de: (p, ctx) => ({
      subject: `Wir haben deine Meldung erhalten (${p.reportId})`,
      heading: 'Meldung erhalten',
      paragraphs: [
        `Referenz: ${p.reportId}. Wir prüfen sie bis ${date(ctx, p.dueAt, true)} und schicken dir das Ergebnis per E-Mail.`,
        'Weitere Angaben, etwa ein Link oder der Dateiname des Videos, kannst du antworten.',
      ],
    }),
    es: (p, ctx) => ({
      subject: `Recibimos tu reporte (${p.reportId})`,
      heading: 'Reporte recibido',
      paragraphs: [
        `Referencia: ${p.reportId}. Lo revisaremos antes del ${date(ctx, p.dueAt, true)} y te escribiremos el resultado.`,
        'Para añadir un enlace o el nombre del archivo, responde a este correo.',
      ],
    }),
    fr: (p, ctx) => ({
      subject: `Nous avons reçu votre signalement (${p.reportId})`,
      heading: 'Signalement reçu',
      paragraphs: [
        `Référence : ${p.reportId}. Nous l’examinerons avant le ${date(ctx, p.dueAt, true)} et vous enverrons le résultat.`,
        'Pour ajouter un lien ou le nom du fichier, répondez à cet e-mail.',
      ],
    }),
    'pt-BR': (p, ctx) => ({
      subject: `Recebemos sua denúncia (${p.reportId})`,
      heading: 'Denúncia recebida',
      paragraphs: [
        `Referência: ${p.reportId}. Vamos analisar até ${date(ctx, p.dueAt, true)} e enviar o resultado por e-mail.`,
        'Para incluir um link ou o nome do arquivo, responda a esta mensagem.',
      ],
    }),
    'zh-TW': (p, ctx) => ({
      subject: `我們已收到你的檢舉（${p.reportId}）`,
      heading: '已收到檢舉',
      paragraphs: [
        `檢舉編號：${p.reportId}。我們會在 ${date(ctx, p.dueAt, true)} 前處理完，結果寄到這個信箱。`,
        '若要補充資訊（例如影片連結或下載檔名），直接回覆這封信。',
      ],
    }),
  },

  takedown_resolved: {
    en: (p) => ({
      subject: `Update on your report (${p.reportId})`,
      heading: p.outcome === 'removed' ? 'Content removed' : 'No action taken',
      paragraphs:
        p.outcome === 'removed'
          ? ['We reviewed your report and removed the content. The source photo is now blocked from being uploaded again.']
          : [
              "Based on the information provided, we couldn't identify content to remove.",
              "If you have a link or the video's file name (it contains an ID starting with gen_), reply to this email and we'll take another look.",
            ],
    }),
    de: (p) => ({
      subject: `Update zu deiner Meldung (${p.reportId})`,
      heading: p.outcome === 'removed' ? 'Inhalt entfernt' : 'Keine Maßnahme',
      paragraphs:
        p.outcome === 'removed'
          ? ['Wir haben deine Meldung geprüft und den Inhalt entfernt. Das Ausgangsfoto kann nicht erneut hochgeladen werden.']
          : [
              'Mit den vorliegenden Angaben konnten wir keinen Inhalt zum Entfernen finden.',
              'Wenn du einen Link oder den Dateinamen hast (darin steht eine ID mit gen_), antworte auf diese E-Mail. Wir schauen noch einmal nach.',
            ],
    }),
    es: (p) => ({
      subject: `Novedades de tu reporte (${p.reportId})`,
      heading: p.outcome === 'removed' ? 'Contenido retirado' : 'Sin medidas',
      paragraphs:
        p.outcome === 'removed'
          ? ['Revisamos tu reporte y retiramos el contenido. La foto de origen queda bloqueada para nuevas subidas.']
          : [
              'Con la información disponible no pudimos identificar contenido que retirar.',
              'Si tienes un enlace o el nombre del archivo (incluye un ID que empieza por gen_), responde a este correo y lo revisamos de nuevo.',
            ],
    }),
    fr: (p) => ({
      subject: `Suite de votre signalement (${p.reportId})`,
      heading: p.outcome === 'removed' ? 'Contenu retiré' : 'Aucune mesure',
      paragraphs:
        p.outcome === 'removed'
          ? ['Nous avons examiné votre signalement et retiré le contenu. La photo source ne peut plus être envoyée.']
          : [
              'Avec les informations fournies, nous n’avons pas identifié de contenu à retirer.',
              'Si vous avez un lien ou le nom du fichier (il contient un identifiant commençant par gen_), répondez à cet e-mail.',
            ],
    }),
    'pt-BR': (p) => ({
      subject: `Atualização da sua denúncia (${p.reportId})`,
      heading: p.outcome === 'removed' ? 'Conteúdo removido' : 'Nenhuma medida',
      paragraphs:
        p.outcome === 'removed'
          ? ['Analisamos a denúncia e removemos o conteúdo. A foto de origem não pode ser enviada de novo.']
          : [
              'Com as informações enviadas, não localizamos conteúdo para remover.',
              'Se você tiver um link ou o nome do arquivo (com um ID que começa com gen_), responda a este e-mail.',
            ],
    }),
    'zh-TW': (p) => ({
      subject: `你的檢舉有結果了（${p.reportId}）`,
      heading: p.outcome === 'removed' ? '內容已刪除' : '檢舉未成立',
      paragraphs:
        p.outcome === 'removed'
          ? ['我們核對了你的檢舉，已刪除相關影片，並禁止同一張照片再次上傳。']
          : [
              '依目前的資訊，我們沒有找到需要刪除的內容。',
              '如果你有影片連結或下載檔名（檔名裡有 gen_ 開頭的編號），請回覆這封信，我們會再查一次。',
            ],
    }),
  },

  content_removed: {
    en: (p) => ({
      subject: `A video in your ${brand} account was removed`,
      heading: 'Video removed',
      paragraphs: [
        `Following a report (${p.reportId}), we removed ${p.videos} video(s) made from the same photo and blocked that photo from future uploads.`,
        'Only upload photos of yourself or of people who agreed to it. If you think this was a mistake, reply to this email.',
      ],
    }),
    de: (p) => ({
      subject: `Ein Video in deinem ${brand}-Konto wurde entfernt`,
      heading: 'Video entfernt',
      paragraphs: [
        `Nach einer Meldung (${p.reportId}) haben wir ${p.videos} Video(s) aus demselben Foto entfernt und weitere Uploads dieses Fotos gesperrt.`,
        'Lade nur Fotos von dir oder von Personen hoch, die zugestimmt haben. Wenn das ein Fehler war, antworte auf diese E-Mail.',
      ],
    }),
    es: (p) => ({
      subject: `Retiramos un video de tu cuenta de ${brand}`,
      heading: 'Video retirado',
      paragraphs: [
        `Tras un reporte (${p.reportId}), retiramos ${p.videos} video(s) hechos con la misma foto y bloqueamos esa foto.`,
        'Sube solo fotos tuyas o de personas que lo hayan aceptado. Si crees que es un error, responde a este correo.',
      ],
    }),
    fr: (p) => ({
      subject: `Une vidéo de votre compte ${brand} a été retirée`,
      heading: 'Vidéo retirée',
      paragraphs: [
        `Après un signalement (${p.reportId}), nous avons retiré ${p.videos} vidéo(s) issues de la même photo et bloqué cette photo.`,
        'N’envoyez que vos photos ou celles de personnes qui ont accepté. Si vous pensez qu’il s’agit d’une erreur, répondez à cet e-mail.',
      ],
    }),
    'pt-BR': (p) => ({
      subject: `Um vídeo da sua conta ${brand} foi removido`,
      heading: 'Vídeo removido',
      paragraphs: [
        `Depois de uma denúncia (${p.reportId}), removemos ${p.videos} vídeo(s) feitos com a mesma foto e bloqueamos novos envios dessa foto.`,
        'Envie apenas fotos suas ou de pessoas que autorizaram. Se achar que houve engano, responda a este e-mail.',
      ],
    }),
    'zh-TW': (p) => ({
      subject: `你在 ${brand} 的影片已被刪除`,
      heading: '影片已被刪除',
      paragraphs: [
        `收到檢舉（${p.reportId}）後，我們刪除了用同一張照片產生的 ${p.videos} 支影片，並禁止這張照片再次上傳。`,
        '只能上傳你本人或已取得對方同意的照片。如果認為處理有誤，請回覆這封信。',
      ],
    }),
  },
}

const ADMIN_RENDERERS: { [K in AdminTemplate]: Render<K> } = {
  admin_takedown: (p, ctx) => {
    const title = { new: '新举报', due_soon: '举报即将超时', overdue: '举报已超时' }[p.stage]
    return {
      subject: `[${brand}] ${title}：${p.reportId}`,
      heading: title,
      paragraphs: [
        `原因：${REASONS_ZH[p.reason] ?? p.reason}`,
        `视频：${p.generationId ?? '未能自动定位，需要人工查找'}`,
        `截止：${operatorDate(p.dueAt, true)}`,
      ],
      cta: { label: '去处理', url: `${ctx.siteUrl}/admin/takedowns` },
    }
  },

  admin_contact: (p, ctx) => ({
    subject: `[${brand}] 新留言：${TOPICS_ZH[p.topic] ?? p.topic}`,
    heading: '新留言',
    paragraphs: [`来自：${p.email}（直接回复本邮件即可回复对方）`, p.message],
    cta: { label: '在后台查看', url: `${ctx.siteUrl}/admin/messages` },
    replyTo: p.email,
  }),

  admin_alert: (p, ctx) => {
    const alert = ALERTS_ZH[p.kind](p)
    return {
      subject: `[${brand}] 告警：${alert.title}`,
      heading: alert.title,
      paragraphs: [alert.summary, p.detail ? `详情：${p.detail}` : '', alert.hint],
      cta: { label: '去后台查看', url: `${ctx.siteUrl}${alert.path}` },
    }
  },
}

export const ADMIN_TEMPLATES = Object.keys(ADMIN_RENDERERS) as readonly EmailTemplate[]

export function isEmailTemplate(value: string): value is EmailTemplate {
  return Object.hasOwn(USER_TEMPLATES, value) || Object.hasOwn(ADMIN_RENDERERS, value)
}

function isAdminTemplate(template: EmailTemplate): template is AdminTemplate {
  return Object.hasOwn(ADMIN_RENDERERS, template)
}

export function renderEmail<K extends EmailTemplate>(template: K, params: TemplateParams[K], options: { siteUrl: string; locale: string | null }): RenderedEmail {
  const ctx: Ctx = { siteUrl: options.siteUrl.replace(/\/$/, ''), locale: isLocale(options.locale ?? undefined) ? (options.locale as Locale) : DEFAULT_LOCALE }
  const render = (isAdminTemplate(template) ? ADMIN_RENDERERS[template] : USER_TEMPLATES[template as UserTemplate][ctx.locale]) as Render<K>
  const block = render(params, ctx)
  const paragraphs = block.paragraphs.filter(Boolean)
  // Subject 只由固定文案和系统生成的 id 组成；仍去掉换行，防止邮件头注入
  const subject = block.subject.replace(/[\r\n]+/g, ' ').slice(0, 200)
  const text = [
    block.heading,
    '',
    ...paragraphs.flatMap((p) => [p, '']),
    ...(block.cta ? [`${block.cta.label}: ${block.cta.url}`, ''] : []),
    ...(block.footer ? [block.footer, ''] : []),
    `— ${brand} · ${site.supportEmail}`,
  ].join('\n')
  return { subject, text, html: layout(block, paragraphs), replyTo: block.replyTo ?? site.supportEmail }
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)
}

function layout(block: Block, paragraphs: string[]) {
  const p = (value: string) =>
    `<p style="margin:0 0 14px;font-size:15px;line-height:24px;color:#27272a;white-space:pre-wrap">${escapeHtml(value)}</p>`
  const cta = block.cta
    ? `<p style="margin:22px 0 4px"><a href="${escapeHtml(block.cta.url)}" style="display:inline-block;background:#18181b;color:#ffffff;padding:12px 20px;border-radius:8px;font-size:15px;font-weight:600;text-decoration:none">${escapeHtml(block.cta.label)}</a></p>`
    : ''
  const footer = block.footer ? `<p style="margin:0 0 8px">${escapeHtml(block.footer)}</p>` : ''
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif">
<div style="max-width:520px;margin:0 auto;padding:32px 20px">
<div style="font-size:17px;font-weight:700;color:#18181b;margin-bottom:20px">${escapeHtml(brand)}</div>
<div style="background:#ffffff;border-radius:12px;padding:28px 26px">
<h1 style="margin:0 0 16px;font-size:21px;line-height:28px;color:#18181b">${escapeHtml(block.heading)}</h1>
${paragraphs.map(p).join('\n')}${cta}
</div>
<div style="padding:18px 6px 0;font-size:12px;line-height:18px;color:#71717a">${footer}<p style="margin:0">${escapeHtml(brand)} · <a href="mailto:${escapeHtml(site.supportEmail)}" style="color:#71717a">${escapeHtml(site.supportEmail)}</a></p></div>
</div></body></html>`
}
