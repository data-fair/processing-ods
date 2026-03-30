import config from 'config'
import { it, describe } from 'node:test'
import testUtils from '@data-fair/lib-processing-dev/tests-utils.js'
import * as odsPlugin from '../index.ts'

describe('ODS Processing', () => {
  it('should upload at least one dataset from Corbeil-Essonnes ODS', async function () {
    const context = testUtils.context({
      pluginConfig: {},
      processingConfig: {
        url: 'https://corbeil-essonnes-grandparissud.opendatasoft.com',
        account: { type: 'organization', id: 'test', name: 'Test' },
      },
    }, config, false)

    await odsPlugin.run(context)
  })
})
