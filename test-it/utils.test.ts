import { it, describe } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeDescriptor, resolveSlugs, getMetadata, odsGet, withRetry429, stageLabelFor } from '../lib/utils.ts'
import type { OdsDataset } from '../lib/types.ts'

describe('normalizeDescriptor', () => {
  it('treats a /catalog dataset (no source_* metas) as a non-federated, clean id', () => {
    const raw = { dataset_id: 'budget-2024', metas: { default: {} } } as OdsDataset
    const d = normalizeDescriptor(raw)
    assert.equal(d.fullId, 'budget-2024')
    assert.equal(d.cleanId, 'budget-2024')
    assert.equal(d.isFederated, false)
  })

  it('treats a /shared own dataset (source_domain === parent_domain) as non-federated with clean source_dataset id', () => {
    const raw = {
      dataset_id: 'budget-2024@datacorsica',
      metas: { default: { source_domain: 'datacorsica', parent_domain: 'datacorsica', source_dataset: 'budget-2024' } }
    } as unknown as OdsDataset
    const d = normalizeDescriptor(raw)
    assert.equal(d.fullId, 'budget-2024@datacorsica')
    assert.equal(d.cleanId, 'budget-2024')
    assert.equal(d.isFederated, false)
  })

  it('detects a federated dataset (source_domain !== parent_domain) and exposes its source info', () => {
    const raw = {
      dataset_id: 'sanctuaire-pelagos@oddc-datacorsica',
      metas: {
        default: {
          source_domain: 'oddc-datacorsica',
          parent_domain: 'datacorsica',
          source_dataset: 'sanctuaire-pelagos',
          source_domain_address: 'oddc-datacorsica.opendatasoft.com'
        }
      }
    } as unknown as OdsDataset
    const d = normalizeDescriptor(raw)
    assert.equal(d.fullId, 'sanctuaire-pelagos@oddc-datacorsica')
    assert.equal(d.cleanId, 'sanctuaire-pelagos')
    assert.equal(d.isFederated, true)
    assert.equal(d.sourceDomain, 'oddc-datacorsica')
    assert.equal(d.sourceDomainAddress, 'oddc-datacorsica.opendatasoft.com')
    assert.equal(d.sourceDataset, 'sanctuaire-pelagos')
  })
})

describe('resolveSlugs', () => {
  const local = (id: string) => normalizeDescriptor({ dataset_id: id, metas: { default: {} } } as OdsDataset)
  const federated = (cleanId: string, domain: string) => normalizeDescriptor({
    dataset_id: `${cleanId}@${domain}`,
    metas: { default: { source_domain: domain, parent_domain: 'datacorsica', source_dataset: cleanId, source_domain_address: `${domain}.opendatasoft.com` } }
  } as unknown as OdsDataset)

  it('keeps clean slugs when there is no collision', () => {
    const slugs = resolveSlugs([local('a'), federated('b', 'oddc-datacorsica')])
    assert.equal(slugs.get('a'), 'a')
    assert.equal(slugs.get('b@oddc-datacorsica'), 'b')
  })

  it('keeps the local slug clean and suffixes the federated one on a local/federated collision', () => {
    const slugs = resolveSlugs([local('budget'), federated('budget', 'oddc-datacorsica')])
    assert.equal(slugs.get('budget'), 'budget')
    assert.equal(slugs.get('budget@oddc-datacorsica'), 'budget-oddc-datacorsica')
  })

  it('suffixes both federated datasets on a federated/federated collision', () => {
    const slugs = resolveSlugs([federated('parc', 'oddc-datacorsica'), federated('parc', 'autre-domaine')])
    assert.equal(slugs.get('parc@oddc-datacorsica'), 'parc-oddc-datacorsica')
    assert.equal(slugs.get('parc@autre-domaine'), 'parc-autre-domaine')
  })
})

describe('getMetadata', () => {
  it('sets origin to the source portal dataset page for a federated dataset', () => {
    const raw = {
      dataset_id: 'sanctuaire-pelagos@oddc-datacorsica',
      metas: {
        default: {
          title: 'Sanctuaire PELAGOS',
          references: 'https://georchestra.example/should-be-ignored',
          source_domain: 'oddc-datacorsica',
          parent_domain: 'datacorsica',
          source_dataset: 'sanctuaire-pelagos',
          source_domain_address: 'oddc-datacorsica.opendatasoft.com'
        }
      }
    } as unknown as OdsDataset
    const descriptor = normalizeDescriptor(raw)
    const meta = getMetadata(descriptor, 'sanctuaire-pelagos', 'https://www.data.corsica')
    assert.equal(meta.slug, 'sanctuaire-pelagos')
    assert.equal(meta.origin, 'https://oddc-datacorsica.opendatasoft.com/explore/dataset/sanctuaire-pelagos/')
  })

  it('keeps the references-based origin for a local dataset and uses the resolved slug', () => {
    const raw = {
      dataset_id: 'budget-2024',
      metas: { default: { title: 'Budget', references: 'https://example.org/source' } }
    } as unknown as OdsDataset
    const descriptor = normalizeDescriptor(raw)
    const meta = getMetadata(descriptor, 'budget-2024', 'https://www.data.corsica')
    assert.equal(meta.slug, 'budget-2024')
    assert.equal(meta.origin, 'https://example.org/source')
  })
})

describe('odsGet', () => {
  const silentLog = { warning: async () => {} }

  it('retries on 429 and returns the result once the server recovers', async () => {
    let attempts = 0
    const axios = {
      get: async () => {
        attempts++
        if (attempts < 3) { const e: any = new Error('rate limited'); e.response = { status: 429 }; throw e }
        return { data: 'ok' }
      }
    }
    const res = await odsGet(axios, 'http://ods/x', undefined, { log: silentLog, delayMs: 0 })
    assert.equal(res.data, 'ok')
    assert.equal(attempts, 3)
  })

  it('gives up after the configured number of retries and rethrows the last error', async () => {
    let attempts = 0
    const axios = { get: async () => { attempts++; const e: any = new Error('still 429'); e.status = 429; throw e } }
    await assert.rejects(
      odsGet(axios, 'http://ods/x', undefined, { log: silentLog, retries: 3, delayMs: 0 }),
      /still 429/
    )
    assert.equal(attempts, 4) // 1 initial + 3 retries
  })

  it('does not retry on a non-429 error', async () => {
    let attempts = 0
    const axios = { get: async () => { attempts++; const e: any = new Error('boom'); e.response = { status: 500 }; throw e } }
    await assert.rejects(odsGet(axios, 'http://ods/x', undefined, { log: silentLog, delayMs: 0 }), /boom/)
    assert.equal(attempts, 1)
  })
})

describe('withRetry429', () => {
  const silentLog = { warning: async () => {} }

  it('returns the result without retrying when the call succeeds', async () => {
    let attempts = 0
    const res = await withRetry429(async () => { attempts++; return 'ok' }, { log: silentLog, delayMs: 0 })
    assert.equal(res, 'ok')
    assert.equal(attempts, 1)
  })

  it('retries on 429 (err.response.status) then returns once it succeeds', async () => {
    let attempts = 0
    const res = await withRetry429(async () => {
      attempts++
      if (attempts < 3) { const e: any = new Error('rate limited'); e.response = { status: 429 }; throw e }
      return 'ok'
    }, { log: silentLog, delayMs: 0 })
    assert.equal(res, 'ok')
    assert.equal(attempts, 3)
  })

  it('detects 429 from err.status too', async () => {
    let attempts = 0
    const res = await withRetry429(async () => {
      attempts++
      if (attempts < 2) { const e: any = new Error('rate limited'); e.status = 429; throw e }
      return 'ok'
    }, { log: silentLog, delayMs: 0 })
    assert.equal(res, 'ok')
    assert.equal(attempts, 2)
  })

  it('gives up after the configured number of retries and rethrows the last error', async () => {
    let attempts = 0
    await assert.rejects(
      withRetry429(async () => { attempts++; const e: any = new Error('still 429'); e.status = 429; throw e }, { log: silentLog, retries: 3, delayMs: 0 }),
      /still 429/
    )
    assert.equal(attempts, 4) // 1 initial + 3 retries
  })

  it('does not retry a non-429 error', async () => {
    let attempts = 0
    await assert.rejects(
      withRetry429(async () => { attempts++; const e: any = new Error('boom'); e.response = { status: 500 }; throw e }, { log: silentLog, delayMs: 0 }),
      /boom/
    )
    assert.equal(attempts, 1)
  })
})

describe('stageLabelFor', () => {
  it('labels the download stage as an ODS download', () => {
    assert.equal(stageLabelFor('download'), 'lors du téléchargement depuis ODS')
  })

  it('labels the upload stage as a Data-Fair upload', () => {
    assert.equal(stageLabelFor('upload'), "lors de l'upload vers Data-Fair")
  })

  it('labels the metadata-refresh stage as a Data-Fair metadata update, not ODS', () => {
    assert.equal(stageLabelFor('meta'), 'lors de la mise à jour des métadonnées dans Data-Fair')
  })
})
