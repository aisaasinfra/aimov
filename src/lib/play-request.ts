// Sticky Create and the hero Create button share this decision.
// The hero button can disable itself. The sticky bar is off-screen from the checkbox, so it has to say what to do next.

export type PlayRequestPlan = 'wait' | 'sign-in' | 'pricing' | 'pick-file' | 'need-consent' | 'generate'

export function playRequestPlan(input: {
  loading: boolean
  busy: boolean
  signedIn: boolean
  shortfall: number
  hasPhoto: boolean
  consent: boolean
}): PlayRequestPlan {
  if (input.loading || input.busy) return 'wait'
  if (!input.signedIn) return 'sign-in'
  if (input.shortfall > 0) return 'pricing'
  if (!input.hasPhoto) return 'pick-file'
  if (!input.consent) return 'need-consent'
  return 'generate'
}
