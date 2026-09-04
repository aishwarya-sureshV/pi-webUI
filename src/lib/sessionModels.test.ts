import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { formatSessionModelName, sessionUsesModel, uniqueSessionModels } from './sessionModels.ts'

describe('formatSessionModelName', () => {
  it('labels DeepSeek V4 Pro from the ollama id', () => {
    assert.equal(formatSessionModelName('deepseek-v4-pro:cloud'), 'DeepSeek V4 Pro')
  })

  it('labels other common session models', () => {
    assert.equal(formatSessionModelName('glm-5.3-flash:cloud'), 'GLM 5.3 Flash')
    assert.equal(formatSessionModelName('claude-sonnet-5'), 'Claude Sonnet 5')
  })
})

describe('sessionUsesModel', () => {
  it('matches a model used for one turn even when it is not lastModel', () => {
    const session = {
      lastModel: 'glm-5.3-flash:cloud',
      models: ['deepseek-v4-pro:cloud', 'glm-5.3-flash:cloud'],
    }
    assert.equal(sessionUsesModel(session, 'deepseek-v4-pro:cloud'), true)
    assert.equal(sessionUsesModel(session, 'glm-5.3-flash:cloud'), true)
    assert.equal(sessionUsesModel(session, 'kimi-k3:cloud'), false)
  })

  it('falls back to lastModel when models is missing', () => {
    assert.equal(sessionUsesModel({ lastModel: 'deepseek-v4-pro:cloud' }, 'deepseek-v4-pro:cloud'), true)
  })
})

describe('uniqueSessionModels', () => {
  it('lists DeepSeek when it appears on any session', () => {
    const options = uniqueSessionModels([
      { lastModel: 'glm-5.3-flash:cloud', models: ['deepseek-v4-pro:cloud', 'glm-5.3-flash:cloud'] },
      { lastModel: 'deepseek-v4-pro:cloud', models: ['deepseek-v4-pro:cloud'] },
    ])
    assert.deepEqual(options.map((option) => option.id).sort(), ['deepseek-v4-pro:cloud', 'glm-5.3-flash:cloud'])
    assert.equal(options.find((option) => option.id === 'deepseek-v4-pro:cloud')?.label, 'DeepSeek V4 Pro')
  })
})
