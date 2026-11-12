import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'
import type { On, PromptSubmitInput } from 'claude-code'

// Più sessioni nella stessa cartella: ognuna ha il suo handoff in
// .claude/handoff/pending/<session id>.md e il /clear con la ripresa avvengono
// solo nella sessione che l'ha scritto. Le sessioni sono processi diversi con
// la stessa cartella: qui un solo modulo, con i file in comune e l'id di
// sessione che cambia da un turno all'altro.

const ROOT = 'C:/progetti'
const DIR = `${ROOT}/.claude/handoff`
const LEGACY = `${DIR}/pending.md`
const pendingOf = (session: string) => `${DIR}/pending/${session}.md`

const handoff = (title: string, session?: string) =>
  [
    '---',
    'status: validated',
    ...(session === undefined ? [] : [`session: ${session}`]),
    'validated_at: 2026-10-18T08:00:00Z',
    'rounds: 1',
    '---',
    `# Handoff: ${title}`,
    '',
    '## Prossimo passo immediato',
    `Riprendere ${title}.`,
  ].join('\n')

const typed = (text: string): PromptSubmitInput => ({ text, wait: false, origin: { kind: 'composer' } })

// Su macOS/Linux una radice "C:/…" non è assoluta e il motore le antepone la
// cartella del plugin: si confronta dal punto in cui compare ROOT.
const key = (path: string) => {
  const slashed = path.replace(/\\/g, '/')
  const at = slashed.indexOf(ROOT)
  return at < 0 ? slashed : slashed.slice(at)
}

const world = (on: On) => {
  mock.store(on)
  mock.clock(on, { now: 1_000_000 })
  const state = {
    session: 'A',
    files: new Map<string, string>(),
    prompts: [] as PromptSubmitInput[],
    commands: [] as string[],
    logs: [] as string[],
  }
  on('session.root', () => ({ value: ROOT }))
  on('session.id', () => ({ value: state.session }))
  on('agent.list', () => ({ value: [] }))
  on('ui.log', (_, e) => {
    state.logs.push(e.text)
    return { value: undefined }
  })
  on('fs.read', (_, e) => {
    const text = state.files.get(key(e.path))
    return text === undefined ? { deny: `ENOENT ${e.path}` } : { value: text }
  })
  on('fs.write', (_, e) => {
    state.files.set(key(e.path), e.text)
    return { value: undefined }
  })
  on('fs.stat', (_, e) => ({ deny: `ENOENT ${e.path}` }))
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

type World = ReturnType<typeof world>

const settle = async ($: Engine, isDone: () => boolean) => {
  for (let round = 0; round < 50 && !isDone(); round++) {
    await $.session.measure({ context: { window: 1 }, rateLimits: [], changed: ['context'] })
  }
}

let turns = 0
// Una sessione chiude il turno; true se la mod ha chiesto un /clear.
const endTurn = async ($: Engine, state: World, session: string) => {
  state.session = session
  const before = state.commands.length
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: `t${++turns}`, reason: 'answer' })
  await settle($, () => state.commands.length > before)
  return state.commands.length > before
}

// Un /clear nella sessione `from`, che riparte come `to`: il testo che
// SessionStart allega.
const clear = async ($: Engine, state: World, from: string, to: string) => {
  await $.session.end({ reason: 'clear', sessionId: from, resume: { id: from } })
  state.session = to
  return ((await $.classic.SessionStart({ source: 'clear' })).additionalContext ?? []).join('\n')
}

const resumes = (state: World) => state.prompts.filter(prompt => prompt.origin.kind === 'plugin')
const archived = (state: World) => [...state.files.entries()].filter(([path]) => path.includes('/.claude/handoff/archive/'))

test("una sessione che chiude il turno non prende l'handoff validato di un'altra", async ($, on) => {
  const state = world(on)
  state.files.set(pendingOf('A'), handoff('Wave 2b', 'A'))

  // B (la dashboard) chiude il turno mentre l'handoff di A è validato.
  expect(await endTurn($, state, 'B')).toBe(false)
  // Neanche un /clear a mano in B lo allega.
  expect(await clear($, state, 'B', 'B2')).not.toContain('Wave 2b')
  expect(state.files.get(pendingOf('A'))).toBe(handoff('Wave 2b', 'A'))
  expect(archived(state).length).toBe(0)

  // A chiude il turno: /clear, handoff allegato, archiviato, una ripresa.
  expect(await endTurn($, state, 'A')).toBe(true)
  const attached = await clear($, state, 'A', 'A2')
  expect(attached).toContain('Riprendere Wave 2b.')
  await settle($, () => resumes(state).length > 0)
  expect(resumes(state).length).toBe(1)
  expect(state.files.get(pendingOf('A'))).toBe('')
  expect(archived(state).map(([, text]) => text)).toEqual([handoff('Wave 2b', 'A')])
  expect(state.commands).toEqual(['clear'])
})

test('due handoff validati nella stessa cartella: ognuno riparte solo nella sua sessione', async ($, on) => {
  const state = world(on)
  state.files.set(pendingOf('A'), handoff('portfolio', 'A'))
  state.files.set(pendingOf('B'), handoff('dashboard', 'B'))

  expect(await endTurn($, state, 'B')).toBe(true)
  const inB = await clear($, state, 'B', 'B2')
  expect(inB).toContain('Riprendere dashboard.')
  expect(inB).not.toContain('portfolio')
  expect(state.files.get(pendingOf('A'))).toBe(handoff('portfolio', 'A'))
  expect(state.files.get(pendingOf('B'))).toBe('')

  expect(await endTurn($, state, 'A')).toBe(true)
  const inA = await clear($, state, 'A', 'A2')
  expect(inA).toContain('Riprendere portfolio.')
  expect(inA).not.toContain('dashboard')
  expect(state.files.get(pendingOf('A'))).toBe('')
  expect(state.commands).toEqual(['clear', 'clear'])
  expect(resumes(state).length).toBe(2)
})

test("un pending.md del formato vecchio senza session non fa /clear né ripresa in nessuna sessione e resta dov'è", async ($, on) => {
  const state = world(on)
  state.files.set(LEGACY, handoff('vecchio'))

  expect(await endTurn($, state, 'A')).toBe(false)
  expect(await endTurn($, state, 'A')).toBe(false)
  expect(await endTurn($, state, 'B')).toBe(false)
  expect(await clear($, state, 'B', 'B2')).not.toContain('Riprendere vecchio.')
  state.session = 'A'
  expect(((await $.classic.SessionStart({ source: 'compact' })).additionalContext ?? []).join('\n')).not.toContain('Riprendere vecchio.')

  expect(state.files.get(LEGACY)).toBe(handoff('vecchio'))
  expect(archived(state).length).toBe(0)
  // Il motivo compare una volta sola, non a ogni fine turno.
  expect(state.logs.filter(line => line.includes('pending.md') && line.includes('session')).length).toBe(1)
})

test('un pending.md del formato vecchio con session vale solo per quella sessione', async ($, on) => {
  const state = world(on)
  state.files.set(LEGACY, handoff('vecchio di A', 'A'))

  expect(await endTurn($, state, 'B')).toBe(false)
  expect(await clear($, state, 'B', 'B2')).not.toContain('vecchio di A')

  expect(await endTurn($, state, 'A')).toBe(true)
  expect(await clear($, state, 'A', 'A2')).toContain('Riprendere vecchio di A.')
  expect(state.files.get(LEGACY)).toBe('')
  expect(archived(state).length).toBe(1)
})

test("il file di una sessione con l'id di un'altra nel frontmatter non fa partire nulla", async ($, on) => {
  const state = world(on)
  state.files.set(pendingOf('A'), handoff('copiato', 'B'))

  expect(await endTurn($, state, 'A')).toBe(false)
  expect(await endTurn($, state, 'B')).toBe(false)
  expect(state.files.get(pendingOf('A'))).toBe(handoff('copiato', 'B'))
})

test("dopo un compact si allega solo l'handoff della sessione compattata", async ($, on) => {
  const state = world(on)
  state.files.set(pendingOf('A'), handoff('portfolio', 'A'))

  state.session = 'B'
  const inB = await $.classic.SessionStart({ source: 'compact' })
  expect((inB.additionalContext ?? []).join('\n')).not.toContain('portfolio')
  expect(state.files.get(pendingOf('A'))).toBe(handoff('portfolio', 'A'))

  state.session = 'A'
  const inA = await $.classic.SessionStart({ source: 'compact' })
  expect((inA.additionalContext ?? []).join('\n')).toContain('Riprendere portfolio.')
  expect(state.files.get(pendingOf('A'))).toBe('')
})

test('la nota di zona indica il file di handoff della sessione', async ($, on) => {
  const state = world(on)
  state.session = 'B'
  await $.session.measure({ context: { window: 100, tokens: 55, percent: 55 }, rateLimits: [], changed: ['context'] })
  const note = ((await $.prompt.submit(typed('continua'))).context ?? []).join(' ')
  expect(note).toContain('.claude/handoff/pending/B.md')
  expect(note).not.toContain('.claude/handoff/pending.md')
})

test("un /clear a mano nella sessione che ha scritto l'handoff lo allega, senza prompt di ripresa", async ($, on) => {
  const state = world(on)
  state.files.set(pendingOf('A'), handoff('portfolio', 'A'))

  expect(await clear($, state, 'A', 'A2')).toContain('Riprendere portfolio.')
  expect(state.files.get(pendingOf('A'))).toBe('')
  await settle($, () => false)
  expect(resumes(state).length).toBe(0)
  expect(state.commands.length).toBe(0)
})

test('il file della sessione senza session nel frontmatter vale, e il pending.md vecchio resta dove sta', async ($, on) => {
  const state = world(on)
  state.files.set(pendingOf('A'), handoff('portfolio'))
  state.files.set(LEGACY, handoff('vecchio'))

  expect(await endTurn($, state, 'A')).toBe(true)
  const attached = await clear($, state, 'A', 'A2')
  expect(attached).toContain('Riprendere portfolio.')
  expect(attached).not.toContain('vecchio')
  expect(state.files.get(pendingOf('A'))).toBe('')
  expect(state.files.get(LEGACY)).toBe(handoff('vecchio'))
})
