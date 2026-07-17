import process from 'node:process'

const nodeId = process.argv[2] ?? 'fixture'
let marker = null

const tools = [
  {
    name: 'syzygy_status',
    description: 'Fixture status.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'write_fixture_marker',
    description: 'Set an isolated fixture marker.',
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_fixture_marker',
    description: 'Read an isolated fixture marker.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
]

function toolResult(structuredContent) {
  return { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent, isError: false }
}

function dispatch(message) {
  if (message.id === undefined) return null
  if (message.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2025-11-25',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: `fixture-${nodeId}`, version: '1' },
      },
    }
  }
  if (message.method === 'ping') return { jsonrpc: '2.0', id: message.id, result: {} }
  if (message.method === 'tools/list') return { jsonrpc: '2.0', id: message.id, result: { tools } }
  if (message.method === 'tools/call') {
    const name = message.params?.name
    let result
    if (name === 'syzygy_status') result = toolResult({ nodeId, version: 'fixture', editorReady: true })
    else if (name === 'write_fixture_marker') {
      marker = String(message.params?.arguments?.value ?? '')
      result = toolResult({ nodeId, marker })
    } else if (name === 'read_fixture_marker') result = toolResult({ nodeId, marker })
    else result = { content: [{ type: 'text', text: 'unknown fixture tool' }], structuredContent: { error: 'unknown fixture tool' }, isError: true }
    return { jsonrpc: '2.0', id: message.id, result }
  }
  return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }
}

process.stdin.setEncoding('utf8')
let buffer = ''
process.stdin.on('data', (chunk) => {
  buffer += chunk
  for (;;) {
    const newline = buffer.indexOf('\n')
    if (newline < 0) break
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (!line) continue
    const response = dispatch(JSON.parse(line))
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`)
  }
})
