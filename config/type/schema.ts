export default {
  $id: 'https://github.com/data-fair/processing-ods/config',
  'x-exports': [
    'types',
    'validate'
  ],
  type: 'object',
  title: 'Config',
  additionalProperties: false,
  required: [
    'dataFairUrl',
    'dataFairAPIKey',
    'adminMode',
    'account'
  ],
  properties: {
    dataFairUrl: {
      type: 'string'
    },
    dataFairAPIKey: {
      type: 'string'
    },
    adminMode: {
      type: 'boolean'
    },
    account: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'id', 'name'],
      properties: {
        type: { type: 'string', enum: ['user', 'organization'] },
        id: { type: 'string' },
        name: { type: 'string' },
        department: { type: 'string' },
        departmentName: { type: 'string' }
      }
    }
  }
}
