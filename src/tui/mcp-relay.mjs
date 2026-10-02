/** Stdio MCP bridge. Tool execution belongs to the authenticated API client. */
import { createInterface } from 'node:readline'
const endpoint = process.argv[2]
const token = process.env.MACVM2SUB_TOOL_TOKEN
async function request(route, body) {
  const res = await fetch(`${endpoint}/${route}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(900000) })
  if (!res.ok) throw new Error(`Client tool bridge returned ${res.status}`)
  return res.json()
}
const lines = createInterface({ input: process.stdin })
lines.on('line', async line => {
  let msg
  try {
    msg = JSON.parse(line)
    if (msg.id == null) return
    let result
    if (msg.method === 'initialize') result = { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'macvm2sub-client', version: '1' } }
    else if (msg.method === 'tools/list') result = await request('list', {})
    else if (msg.method === 'tools/call') result = await request('call', msg.params)
    else if (msg.method === 'ping') result = {}
    else { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } }) + '\n'); return }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n')
  } catch (err) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32603, message: err.message } }) + '\n') }
})
