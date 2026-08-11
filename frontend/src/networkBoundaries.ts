export type NetworkBoundaryItem = {
  id: string
  label: string
  defaultState: string
  activation: string
  destination: string
  data: string
}

export const NETWORK_BOUNDARY_ITEMS: readonly NetworkBoundaryItem[] = [
  {
    id: 'local-model',
    label: 'Bundled local model',
    defaultState: 'Available locally; can be turned off',
    activation: 'When you enable local AI and send a request',
    destination: 'Loopback on this computer only',
    data: 'Your prompt and generated tokens stay between Syzygy and the bundled llama.cpp server.',
  },
  {
    id: 'remote-providers',
    label: 'Remote model providers',
    defaultState: 'Off until configured and chosen',
    activation: 'Only after you review the disclosure and choose Send once',
    destination: 'The selected OpenAI, Anthropic, Gemini, or xAI endpoint',
    data: 'The disclosed research envelope, model settings, and provider credential needed for that request.',
  },
  {
    id: 'google-drive',
    label: 'Google Drive collaboration',
    defaultState: 'Off until you link an account',
    activation: 'When you link, browse, read, write, share, or explicitly sync a selected Drive workspace',
    destination: 'Google OAuth, Drive, and Sheets services',
    data: 'OAuth material plus selected-workspace metadata and supported file content. Drive tokens stay in the native core.',
  },
  {
    id: 'self-hosted-collaboration',
    label: 'Self-hosted project relay',
    defaultState: 'Off until you create or accept a legacy or role-specific bearer invitation',
    activation: 'When you explicitly connect/join a project or enable the app-managed private-LAN relay',
    destination: 'The WS/WSS endpoint in the invitation; bundled hosting listens only on the private address you configure',
    data: 'The relay receives project updates and ephemeral presence. Bundled hosting persists bounded document-sync updates but never awareness. Managed invitations carry a role-specific bearer capability that the host can expire, rotate, or revoke; legacy rooms use one read/edit room key. These authorize relay access but do not authenticate self-reported identities, expiry trusts the relay host clock, and the relay log is not a backup.',
  },
  {
    id: 'downloads-updates',
    label: 'Models and app updates',
    defaultState: 'Manual',
    activation: 'When you request a model download or check for/install an update',
    destination: 'Hugging Face for models; GitHub for signed Syzygy releases',
    data: 'Download requests, model bytes, release metadata, and signed update packages—not research content.',
  },
  {
    id: 'crash-reports',
    label: 'Crash reports',
    defaultState: 'Off',
    activation: 'Only after you opt in and an unexpected error occurs',
    destination: 'Syzygy\'s Sentry project',
    data: 'Scrubbed error and stack trace, app version, and OS—never questions, prompts, or files.',
  },
  {
    id: 'automation',
    label: 'MCP and private LAN control',
    defaultState: 'Off until you connect or enable it',
    activation: 'When an MCP client starts Syzygy or you enable the private LAN developer connection',
    destination: 'Local stdio/loopback, or the private LAN address you configure',
    data: 'Authenticated control requests and bounded workspace results. The control link does not sync research data by itself.',
  },
] as const
