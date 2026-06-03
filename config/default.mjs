// Override these values locally by creating a config/local-test.mjs file (gitignored)
export default {
  /** Base URL of the data-fair instance to connect to. @example "https://staging-koumoul.com/data-fair" */
  dataFairUrl: null,
  /** API key for authenticating requests to data-fair. Generate one in your data-fair settings. */
  dataFairAPIKey: null,
  /** Run the processing as super-admin. */
  adminMode: false,
  /** Account the test processing runs against. @example { type: 'organization', id: 'xxx', name: 'My org' } */
  account: null
}
