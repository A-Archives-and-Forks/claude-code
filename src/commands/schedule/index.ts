import type { Command } from '../../types/command.js'

const scheduleCommand: Command = {
  type: 'local-jsx',
  name: 'schedule',
  aliases: ['cron', 'triggers'],
  description:
    'Manage scheduled remote agent triggers (cloud cron). Requires Claude Pro/Max/Team subscription.',
  // REPL markdown renderer strips `<...>` as HTML tags — use uppercase.
  argumentHint:
    'list | get ID | create CRON PROMPT | update ID FIELD VALUE | delete ID | run ID | enable ID | disable ID',
  isHidden: false,
  isEnabled: () => true,
  bridgeSafe: false,
  availability: ['claude-ai'],
  load: async () => {
    const m = await import('./launchSchedule.js')
    return { call: m.callSchedule }
  },
}

export default scheduleCommand
