import { it, describe } from 'node:test'
import assert from 'node:assert/strict'
import prepare from '../lib/prepare.ts'

describe('prepare', () => {
  it('moves a new API key to the secrets and masks it in the config', async () => {
    const res = await prepare({ processingConfig: { apiKey: 'secret-key' } as any, secrets: {} })
    assert.equal(res.secrets.apiKey, 'secret-key')
    assert.equal(res.processingConfig.apiKey, '********')
  })

  it('keeps the stored secret when the config only holds the masked value', async () => {
    const res = await prepare({ processingConfig: { apiKey: '********' } as any, secrets: { apiKey: 'secret-key' } })
    assert.equal(res.secrets.apiKey, 'secret-key')
    assert.equal(res.processingConfig.apiKey, '********')
  })

  it('deletes the stored secret when the field is emptied', async () => {
    const res = await prepare({ processingConfig: { apiKey: '' } as any, secrets: { apiKey: 'secret-key' } })
    assert.ok(!('apiKey' in res.secrets))
  })

  it('is a no-op when no key is set', async () => {
    const res = await prepare({ processingConfig: { url: 'https://ods.example.com' } as any, secrets: {} })
    assert.ok(!('apiKey' in res.secrets))
    assert.ok(!('apiKey' in res.processingConfig))
  })
})
