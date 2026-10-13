import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'
import type { On, PromptSubmitInput } from 'claude-code'

const ROOT = 'C:/progetto'
const PENDING = `${ROOT}/.claude/handoff/pending.md`
const EXCLUDE = `${ROOT}/.git/info/exclude`

const VALIDATED = [
  '---',
  'status: validated',
  'validated_at: 2026-10-12T08:00:00Z',
  'rounds: 1',
  '---',
  '# Handoff: prova',
  '',
  '## Prossimo passo immediato',
  'Rileggere src/app.ts e lanciare i test.',
].join('\n')

const typed = (text: string): PromptSubmitInput => ({ text, wait: false, origin: { kind: 'composer' } })

// Il motore può passare i percorsi con le barre di Windows.
const key = (path: string) => path.replace(/\\/g, '/')

// Il mondo sotto la mod: file in memoria, una sessione, il fondo di ogni evento.
const world = (on: On) => {
  mock.store(on)
  mock.clock(on, { now: 1_000_000 })
  const state = { session: 's1', files: new Map<string, string>(), prompts: [] as PromptSubmitInput[], commands: [] as string[] }
  on('session.root', () => ({ value: ROOT }))
  on('session.id', () => ({ value: state.session }))
  on('agent.list', () => ({ value: [] }))
  on('fs.read', (_, e) => {
    const text = state.files.get(key(e.path))
    return text === undefined ? { deny: `ENOENT ${e.path}` } : { value: text }
  })
  on('fs.write', (_, e) => {
    state.files.set(key(e.path), e.text)
    return { value: undefined }
  })
  on('fs.stat', (_, e) =>
    key(e.path).endsWith('/.git')
      ? { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } }
      : { deny: `ENOENT ${e.path}` })
  on('prompt.submit', (_, e) => {
    state.prompts.push(e)
    return { text: e.text, context: e.context, origin: e.origin }
  })
  on('command.run', (_, e) => {
    state.commands.push(e.command)
    return { text: `/${e.command}` }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('classic.SessionStart', () => ({}))
  return state
}

// Quello che la mod lancia senza await arriva in fondo dopo qualche giro.
const settle = async ($: Engine, isDone: () => boolean) => {
  for (let round = 0; round < 50 && !isDone(); round++) {
    await $.session.measure({ context: { window: 1 }, rateLimits: [], changed: ['context'] })
  }
}

const turnEnd = (turnId: string) =>
  ({ answer: 'ok', durationMs: 1, isAborted: false, turnId, reason: 'answer' }) as const

test('oltre la soglia la nota parte con il prossimo prompt, una volta per sessione', async ($, on) => {
  world(on)
  const over = { context: { window: 100, tokens: 55, percent: 55 }, rateLimits: [], changed: ['context' as const] }

  await $.session.measure(over)
  const first = await $.prompt.submit(typed('continua'))
  expect((first.context ?? []).join(' ').includes('auto-clear-context:handoff')).toBe(true)

  await $.session.measure(over)
  const second = await $.prompt.submit(typed('ancora'))
  expect((second.context ?? []).length).toBe(0)
})

test('handoff validato: un solo /clear, ripresa automatica, handoff allegato e archiviato', async ($, on) => {
  const state = world(on)
  state.files.set(PENDING, VALIDATED)

  await $.turn.complete(turnEnd('t1'))
  await settle($, () => state.commands.length > 0)
  expect(state.commands).toEqual(['clear'])

  // Il /clear del motore: session.end con reason "clear", poi SessionStart.
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  state.session = 's2'
  const started = await $.classic.SessionStart({ source: 'clear' })
  expect((started.additionalContext ?? []).join('\n').includes('Rileggere src/app.ts')).toBe(true)

  const resumes = () => state.prompts.filter(prompt => prompt.origin.kind === 'plugin')
  await settle($, () => resumes().length > 0)
  expect(resumes().length).toBe(1)
  expect(state.files.get(PENDING)).toBe('')
  expect([...state.files.keys()].some(path => path.includes('/.claude/handoff/archive/'))).toBe(true)
  expect((state.files.get(EXCLUDE) ?? '').includes('.claude/handoff/')).toBe(true)

  // Lo stesso handoff riscritto non ottiene un secondo clear.
  state.files.set(PENDING, VALIDATED)
  await $.turn.complete(turnEnd('t2'))
  await settle($, () => false)
  expect(state.commands.length).toBe(1)
})

test('un handoff in bozza non provoca nessun clear', async ($, on) => {
  const state = world(on)
  state.files.set(PENDING, VALIDATED.replace('status: validated', 'status: draft'))

  await $.turn.complete(turnEnd('t1'))
  await settle($, () => false)
  expect(state.commands.length).toBe(0)
})
