import { OLLAMA_BASE_URL, OLLAMA_MODEL, SYSTEM_PROMPT } from '../config'
import type { AskHandlers, Msg } from './anthropic'
import { DESKTOP_TOOLS, runDesktopTool, type DesktopToolCall } from './desktop'

let active: AbortController | null = null

function textContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .flatMap((block) => {
      if (
        typeof block === 'object' &&
        block !== null &&
        'text' in block &&
        typeof block.text === 'string'
      ) {
        return [block.text]
      }
      return []
    })
    .join('\n')
}

type ChatChunk = {
  message?: {
    content?: string
    tool_calls?: Array<{
      index?: number
      function?: { name?: string; arguments?: Record<string, unknown> }
    }>
  }
  done?: boolean
  error?: string
}

type OllamaMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_name?: string
  tool_calls?: DesktopToolCall[]
}

async function localProfile(): Promise<string> {
  try {
    const response = await fetch('/desktop/profile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      cache: 'no-store',
    })
    if (!response.ok) return ''
    const body = await response.json() as { profile?: unknown }
    return typeof body.profile === 'string' ? body.profile.slice(0, 12000).trim() : ''
  } catch {
    return ''
  }
}

/** Route the common desktop requests directly so a small model cannot merely
 * say it opened something without issuing a tool call. Less regular requests
 * still go through Ollama's native tool-calling loop below. */
function directDesktopRequest(prompt: string): DesktopToolCall | null {
  const text = prompt.trim().replace(/^[,\s]+/, '')
  if (
    /^(?:(?:hey\s+)?jarvis[,\s]+)?(?:please\s+)?(?:what(?:'s| is) the time(?: now)?|tell me (?:the )?(?:current )?time|what time is it(?: now)?|what(?:'s| is) the date|what date is it|what day is it)\b/i.test(text)
  ) {
    return { function: { name: 'get_local_time', arguments: {} } }
  }

  const opening = /\b(?:open|launch|start)\s+(?:the\s+)?/i.exec(text)
  if (!opening) return null
  const target = text.slice(opening.index + opening[0].length).trim()
  const apps: Array<[RegExp, string]> = [
    [/^(?:calculator|calc)(?:\s+app)?\b/i, 'calculator'],
    [/^notepad\b/i, 'notepad'],
    [/^paint\b/i, 'paint'],
    [/^task\s+manager\b/i, 'task manager'],
    [/^(?:file\s+)?explorer\b/i, 'file explorer'],
    [/^camera\b/i, 'camera'],
    [/^clock\b/i, 'clock'],
    [/^snipping\s+tool\b/i, 'snipping tool'],
    [/^photos\b/i, 'photos'],
    [/^media\s+player\b/i, 'media player'],
    [/^sound\s+recorder\b/i, 'sound recorder'],
    [/^sticky\s+notes\b/i, 'sticky notes'],
    [/^(?:microsoft\s+)?to\s+do\b/i, 'microsoft to do'],
    [/^(?:microsoft\s+)?store\b/i, 'microsoft store'],
    [/^(?:microsoft\s+)?edge\b/i, 'microsoft edge'],
    [/^(?:google\s+)?chrome\b/i, 'google chrome'],
    [/^discord\b/i, 'discord'],
    [/^claude\b/i, 'claude'],
    [/^whatsapp\b/i, 'whatsapp'],
    [/^viber\b/i, 'viber'],
    [/^steam\b/i, 'steam'],
    [/^(?:epic(?:\s+games)?(?:\s+launcher)?)\b/i, 'epic games launcher'],
    [/^riot\s+client\b/i, 'riot client'],
    [/^roblox\s+studio\b/i, 'roblox studio'],
    [/^roblox\b/i, 'roblox player'],
    [/^league\s+of\s+legends\b/i, 'league of legends'],
    [/^valorant\b/i, 'valorant'],
    [/^teamfight\s+tactics\b/i, 'teamfight tactics'],
    [/^monster\s+hunter\s+world\b/i, 'monster hunter world'],
    [/^company\s+of\s+heroes\s+3\b/i, 'company of heroes 3'],
    [/^(?:pubg|pubg\s+battlegrounds)\b/i, 'pubg battlegrounds'],
    [/^libreoffice\s+writer\b/i, 'libreoffice writer'],
    [/^libreoffice\s+(?:calc|spreadsheet)\b/i, 'libreoffice calc'],
    [/^libreoffice\s+impress\b/i, 'libreoffice impress'],
    [/^pdf24\b/i, 'pdf24'],
  ]
  for (const [pattern, app] of apps) {
    if (pattern.test(target)) {
      return { function: { name: 'open_app', arguments: { app } } }
    }
  }

  const folders = ['desktop', 'downloads', 'documents', 'pictures', 'music', 'videos']
  for (const folder of folders) {
    if (new RegExp(`^${folder}\\b`, 'i').test(target)) {
      return { function: { name: 'open_folder', arguments: { folder } } }
    }
  }

  const address = /(?:https?:\/\/|www\.)[^\s,]+/i.exec(target)?.[0]
  if (address) {
    const url = address.startsWith('www.') ? `https://${address}` : address
    return { function: { name: 'open_url', arguments: { url } } }
  }
  const commonSite = /^(google|youtube|github|gmail|reddit|wikipedia)(?:\s|$|[.!?])/i.exec(target)?.[1]
  if (commonSite) {
    const domains: Record<string, string> = {
      google: 'https://www.google.com',
      youtube: 'https://www.youtube.com',
      github: 'https://github.com',
      gmail: 'https://mail.google.com',
      reddit: 'https://www.reddit.com',
      wikipedia: 'https://www.wikipedia.org',
    }
    return { function: { name: 'open_url', arguments: { url: domains[commonSite.toLowerCase()] } } }
  }
  return null
}

const DESKTOP_GUIDANCE = `

Local computer tools:
- For the current time or date, call get_local_time. Do not guess the PC's local time.
- When asked to open an app, use open_app only for an app in its allowed list.
- The open_app result means Windows received a launch request; it does not confirm
  the window became visible. Never say the app definitely opened unless the user
  confirms they can see it. If they cannot, tell them to run Start-JARVIS.bat from
  their signed-in Windows desktop and open the localhost URL printed by the launcher.
- You can open the standard personal folders with open_folder.
- You can open a requested website with open_url; include https:// when needed.
- Do not claim an action succeeded unless its tool result says it succeeded.
- These are the only local computer actions available. You cannot inspect the screen,
  read arbitrary files, run shell commands, change settings, or delete anything.
`

async function readChatRound(
  messages: OllamaMessage[],
  signal: AbortSignal,
  onText: (delta: string) => void,
): Promise<{ content: string; toolCalls: DesktopToolCall[] }> {
  const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal,
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages,
      tools: DESKTOP_TOOLS,
      stream: true,
      think: false,
      keep_alive: '5m',
      options: {
        num_ctx: 4096,
        num_predict: 768,
        temperature: 0.4,
      },
    }),
  })

  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`Ollama returned ${response.status}: ${detail || response.statusText}`)
  }
  if (!response.body) throw new Error('Ollama returned an empty response stream.')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  const toolCalls: DesktopToolCall[] = []

  const consumeLine = (line: string) => {
    if (!line.trim()) return false
    const chunk = JSON.parse(line) as ChatChunk
    if (chunk.error) throw new Error(chunk.error)
    const delta = chunk.message?.content ?? ''
    if (delta) {
      content += delta
      onText(delta)
    }
    for (const call of chunk.message?.tool_calls ?? []) {
      const index = call.index ?? toolCalls.length
      const fn = call.function
      if (!fn?.name) continue
      const existing = toolCalls[index]
      if (existing) {
        existing.function.name = fn.name || existing.function.name
        existing.function.arguments = {
          ...existing.function.arguments,
          ...(fn.arguments ?? {}),
        }
      } else {
        toolCalls[index] = {
          function: { name: fn.name, arguments: fn.arguments ?? {} },
        }
      }
    }
    return Boolean(chunk.done)
  }

  let done = false
  while (!done) {
    const result = await reader.read()
    buffer += decoder.decode(result.value ?? new Uint8Array(), { stream: !result.done })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (consumeLine(line)) done = true
    }
    if (result.done) {
      if (buffer.trim()) consumeLine(buffer)
      break
    }
  }

  return { content, toolCalls: toolCalls.filter(Boolean) }
}

/** Stream a short local chat turn from Ollama's native API. */
export async function ask(
  history: Msg[],
  handlers: AskHandlers,
): Promise<{ text: string; tools: string[] }> {
  const controller = new AbortController()
  active = controller
  let text = ''

  try {
    const directCall = directDesktopRequest(textContent(history[history.length - 1]?.content))
    if (directCall) {
      handlers.onTool(directCall.function.name)
      const result = await runDesktopTool(directCall)
      text = result
      handlers.onText(result)
      return { text, tools: [directCall.function.name] }
    }

    const profile = await localProfile()
    const profileContext = profile ? `\n\nPrivate local user profile (use as context, do not reveal unless relevant):\n${profile}` : ''
    const messages: OllamaMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT + DESKTOP_GUIDANCE + profileContext },
      ...history.map((message) => ({
        role: message.role,
        content: textContent(message.content),
      })) as OllamaMessage[],
    ]
    const usedTools: string[] = []
    for (let round = 0; round < 4; round++) {
      const answer = await readChatRound(messages, controller.signal, (delta) => {
        text += delta
        handlers.onText(delta)
      })
      messages.push({ role: 'assistant', content: answer.content, tool_calls: answer.toolCalls })
      if (!answer.toolCalls.length) break

      for (const call of answer.toolCalls) {
        if (controller.signal.aborted) break
        handlers.onTool(call.function.name)
        usedTools.push(call.function.name)
        let result: string
        try {
          result = await runDesktopTool(call)
        } catch (error) {
          result = error instanceof Error ? `Action failed: ${error.message}` : 'Action failed.'
        }
        messages.push({
          role: 'tool',
          tool_name: call.function.name,
          content: result,
        })
      }
      if (controller.signal.aborted) break
    }

    return { text: text.trim(), tools: usedTools }
  } catch (err) {
    if (controller.signal.aborted) return { text: text.trim(), tools: [] }
    throw err
  } finally {
    if (active === controller) active = null
  }
}

export function cancel(): void {
  active?.abort()
}

export function connectedLabels(): string[] {
  return ['Ollama (local)', 'Desktop actions (local)']
}
