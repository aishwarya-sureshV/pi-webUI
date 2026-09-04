import type { ModelInfo } from './api'

/** Identity questions are one short sentence. Work prompts that mention "model" are not. */
const IDENTITY_QUESTION_MAX_CHARS = 240

const LEADING_FLUFF = /^(?:(?:please|hey|hi|hello|yo)[,!]?\s+|(?:can|could|would)\s+(?:you|u)\s+(?:please\s+)?(?:tell me|say)\s+)+/

/**
 * True only when the *whole* message is asking which model/provider/version
 * this session is running. A substring match is not enough: engineering prompts
 * routinely say "what actually needs a model" and must still reach the agent.
 */
export function isModelIdentityQuestion(value: string): boolean {
  let text = value.toLowerCase().replace(/\s+/g, ' ').trim()
  if (!text || text.length > IDENTITY_QUESTION_MAX_CHARS) return false

  text = text
    .replace(/'/g, '')
    .replace(/[?!.,:;#*_/`]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(LEADING_FLUFF, '')
    .trim()
  if (!text) return false

  const which = '(?:what(?:s| is)?|which)'
  const noun = '(?:ai )?(?:model|provider|version)(?: (?:model|provider|version))*'
  const aboutSession = (
    '(?:is this(?: session| chat| one)?(?: using| running)?|this is(?: using| running)?'
    + '|is it|are (?:you|u)(?: using| running)?'
    + '|(?:you|u) using|(?:you|u) running|is(?: currently)? running'
    + '|this session(?: using| running)?|am i (?:using|talking to))'
  )

  return (
    new RegExp(`^${which} ${noun}(?: ${aboutSession})?$`).test(text)
    || new RegExp(`^${noun} ${aboutSession}$`).test(text)
    || new RegExp(`^${aboutSession}(?: using| running)?(?: the)? ${noun}$`).test(text)
    || new RegExp(`^what(?:s| is)? your ${noun}$`).test(text)
  )
}

export function runtimeModelAnswer(model: ModelInfo): string {
  const label = model.name || model.id
  return `This session is running ${label} (${model.provider}/${model.id}), as reported by the backend.`
}
