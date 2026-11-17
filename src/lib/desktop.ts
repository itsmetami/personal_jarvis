type ToolDefinition = {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, { type: 'string'; description: string; enum?: string[] }>
      required?: string[]
    }
  }
}

export const DESKTOP_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'get_local_time',
      description: 'Get the current date, time, and time zone on this PC.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_app',
      description: 'Open one allowed Windows app on this PC.',
      parameters: {
        type: 'object',
        properties: {
          app: {
            type: 'string',
            description: 'The installed app to open by its listed name.',
            enum: [
              'calculator', 'notepad', 'paint', 'task manager', 'file explorer',
              'camera', 'clock', 'snipping tool', 'photos', 'media player',
              'sound recorder', 'sticky notes', 'microsoft to do', 'microsoft store',
              'microsoft edge', 'google chrome', 'discord', 'claude', 'whatsapp',
              'viber', 'steam', 'epic games launcher', 'riot client', 'roblox player',
              'roblox studio', 'league of legends', 'valorant', 'teamfight tactics',
              'monster hunter world', 'company of heroes 3', 'pubg battlegrounds',
              'libreoffice writer', 'libreoffice calc', 'libreoffice impress', 'pdf24',
            ],
          },
        },
        required: ['app'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_folder',
      description: 'Open a standard personal folder in Windows File Explorer.',
      parameters: {
        type: 'object',
        properties: {
          folder: {
            type: 'string',
            description: 'The standard folder to open.',
            enum: ['desktop', 'downloads', 'documents', 'pictures', 'music', 'videos'],
          },
        },
        required: ['folder'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_url',
      description: 'Open an HTTP or HTTPS website in the default browser.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The full HTTP or HTTPS web address.' },
        },
        required: ['url'],
      },
    },
  },
]

export type DesktopToolCall = {
  function: { name: string; arguments: Record<string, unknown> }
}

/** Dispatch only the fixed set of local actions offered to the model. */
export async function runDesktopTool(call: DesktopToolCall): Promise<string> {
  const routes: Record<string, { route: string; pick?: string }> = {
    get_local_time: { route: 'time' },
    open_app: { route: 'open-app', pick: 'app' },
    open_folder: { route: 'open-folder', pick: 'folder' },
    open_url: { route: 'open-url', pick: 'url' },
  }
  const action = routes[call.function.name]
  if (!action) throw new Error('That local action is not available.')

  const body = action.pick
    ? { [action.pick]: call.function.arguments?.[action.pick] }
    : {}
  const response = await fetch(`/desktop/${action.route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload = (await response.json()) as { result?: string; error?: string; timeZone?: string }
  if (!response.ok) throw new Error(payload.error || `Local action failed (${response.status}).`)
  return payload.timeZone
    ? `${payload.result} (time zone: ${payload.timeZone})`
    : payload.result || 'Done.'
}
