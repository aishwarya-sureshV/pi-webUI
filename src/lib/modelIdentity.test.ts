import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isModelIdentityQuestion, runtimeModelAnswer } from './modelIdentity.ts'

describe('isModelIdentityQuestion', () => {
  it('answers short identity questions', () => {
    const yes = [
      'what model are you',
      'What model is this?',
      'which model are you running',
      'what provider is this session using',
      'what version are you',
      'hey, what model are you using?',
      'can you tell me what model this is',
      'what model?',
      'which provider?',
      "what's your model",
      'what model/provider/version',
      'are you using the model',
    ]
    for (const value of yes) {
      assert.equal(isModelIdentityQuestion(value), true, value)
    }
  })

  it('does not swallow work prompts that mention model/provider/version', () => {
    const no = [
      'What actually needs a model',
      'does the model change its mind',
      'same model, same task prompts',
      'what model should I use for the eval harness',
      'implement a model provider version check',
      'Live claude -p only if you must know whether the model bypasses the hook',
    ]
    for (const value of no) {
      assert.equal(isModelIdentityQuestion(value), false, value)
    }
  })

  it('does not intercept the Batch 1 eval-harness prompt', () => {
    const prompt = `
Do not implement all nine at once. Three mechanical harness changes, then measure, then stop.

## What actually needs a model

| Claim | Needs Claude? | Why |
| Hook rewrites | No | Deterministic. Unit test + replay. |
| Those intercepts would have shrunk cache_read | No | Recompute from jsonl with stubbed observations. |
| Snapshot prints the right dest / test command | No | Run snapshot.py on the two repos. |
| Agent stops trying discovery | Yes, eventually | Only a live model chooses not to emit those. |

If replay says ≥30% wasted calls avoided on task 3, start Batch 2 the same way.
`.trim()
    assert.equal(isModelIdentityQuestion(prompt), false)
  })
})

describe('runtimeModelAnswer', () => {
  it('reports backend model identity', () => {
    assert.equal(
      runtimeModelAnswer({ id: 'glm-5.3-flash:cloud', name: 'glm-5.3-flash:cloud', provider: 'ollama' }),
      'This session is running glm-5.3-flash:cloud (ollama/glm-5.3-flash:cloud), as reported by the backend.',
    )
  })
})
