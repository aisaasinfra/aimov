// 纯函数，不引用 jobs / notifications / settings，避免和 auth → settings 绕成环。
// 全站一个开关。没有按模板分轨。库存的 fulfillmentModeByTemplate 不参与解析。

export type FulfillmentMode = 'manual' | 'auto'

// 未设置、空值、非法值都当 manual。只有明确的 auto 才走自动通道。切换只影响之后创建的生成单。
export function resolveFulfillmentMode(settings: { fulfillmentMode?: string | null }): FulfillmentMode {
  return settings.fulfillmentMode === 'auto' ? 'auto' : 'manual'
}
