import config from 'config'
import { it, describe } from 'node:test'
import testUtils from '@data-fair/lib-processing-dev/tests-utils.js'
import * as odsPlugin from '../index.ts'

describe('ODS Processing', () => {
  it('should analyse datasets from Corbeil-Essonnes ODS', async function () {
    const context = testUtils.context({
      pluginConfig: {},
      processingConfig: {
        url: 'https://corbeil-essonnes-grandparissud.opendatasoft.com',
        mode: 'analyse',
      },
    }, config, false)

    await odsPlugin.run(context)
  })
})
