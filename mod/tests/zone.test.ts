import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'
import type { On, PromptSubmitInput, SessionContextBreakdown } from 'claude-code'

const TOOL = 'mcp__auto-clear-context__context_usage'

const typed = (text: string): PromptSubmitInput => ({ text, wait: false, origin: { kind: 'composer' } })

const after = { tool_name: 'Bash', tool_input: {}, tool_response: {}, tool_use_id: 'u1' } as const

// Il mondo sotto il monitor: una sessione (l'id cambia come dopo un /clear), il
// contesto letto da $.session.usage, lo store, il clock e il fondo di misure,
// prompt e PostToolUse. `breakdown` è quello che /context darebbe con un breakdown.
const world = (on: On) => {
  mock.store(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  const state = { session: 's1', percent: undefined as number | undefined, breakdown: undefined as SessionContextBreakdown | undefined }
  on('session.id', () => ({ value: state.session }))
  on('session.root', () => ({ value: 'C:/progetto' }))
  on('session.usage', (_, e) => ({
    value: {
      startedAt: 0,
      context: {
        window: 1_000_000,
        tokens: state.percent === undefined ? undefined : state.percent * 10_000,
        percent: state.percent,
        breakdown: e?.breakdown === undefined ? undefined : state.breakdown,
      },
      rateLimits: [],
    },
  }))
  on('fs.read', (_, e) => ({ deny: `ENOENT ${e.path}` }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.stat', (_, e) => ({ deny: `ENOENT ${e.path}` }))
  on('ui.log', () => ({ value: undefined }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context, origin: e.origin }))
  on('classic.PostToolUse', () => ({}))
  on('classic.SessionStart', () => ({}))
  return { state, clock }
}

const at = (percent: number) => ({ context: { window: 100, tokens: percent, percent }, rateLimits: [], changed: ['context' as const] })

// Le note che il prossimo prompt porta dopo una misura al `percent`.
const viaPrompt = async ($: Engine, percent: number) => {
  await $.session.measure(at(percent))
  return (await $.prompt.submit(typed('continua'))).context ?? []
}

// Le note che un PostToolUse porta, 30 s dopo il precedente.
const viaTool = async ($: Engine, clock: { advance: (ms: number) => Promise<void> }, percent: number, state: { percent?: number }) => {
  state.percent = percent
  await clock.advance(30_000)
  return (await $.classic.PostToolUse(after)).additionalContext ?? []
}

test('col prossimo prompt: una nota per zona per sessione, morbida → dura → margine; un nuovo session id riparte', async ($, on) => {
  const { state } = world(on)

  const [soft, ...soft2] = await viaPrompt($, 45)
  expect(soft2.length).toBe(0)
  expect(soft).toContain('La mod auto-clear-context rileva il contesto al 45% della finestra: zona morbida (soglie 40/60%, margine di sicurezza al 75%).')
  expect(soft).toContain("l'handoff è previsto al prossimo punto naturale: un sotto-task finito e verificato (test verdi o build ok)")
  expect(soft).toContain('Non sono punti adatti: a metà di un edit')
  expect(soft).toContain(TOOL)
  expect((await viaPrompt($, 50)).length).toBe(0)

  const [hard, ...hard2] = await viaPrompt($, 62)
  expect(hard2.length).toBe(0)
  expect(hard).toContain('al 62% della finestra: zona dura (soglie 40/60%, margine di sicurezza al 75%).')
  expect(hard).toContain("si completa l'azione atomica in corso e non se ne iniziano altre")
  expect(hard).toContain('Non sono punti sicuri: a metà di un edit')
  expect(hard).toContain('«Lavoro interrotto»')
  expect((await viaPrompt($, 64)).length).toBe(0)

  const [margin, ...margin2] = await viaPrompt($, 78)
  expect(margin2.length).toBe(0)
  expect(margin).toContain("al 78% della finestra: margine di sicurezza superato (soglie 40/60/75%); l'auto-compact scatta al 97%.")
  expect(margin).toContain("l'handoff è previsto subito, anche fuori dai punti sicuri")
  expect((await viaPrompt($, 90)).length).toBe(0)
  // Il contesto che scende e risale non ripete le zone già segnalate.
  expect((await viaPrompt($, 45)).length).toBe(0)

  // Dopo un /clear l'id della sessione è nuovo: le zone ripartono.
  state.session = 's2'
  expect((await viaPrompt($, 45)).join(' ')).toContain('zona morbida')
})

test('col prossimo prompt: dal normale alla dura parte solo la nota della dura, anche con la morbida in attesa', async ($, on) => {
  world(on)

  expect((await viaPrompt($, 30)).length).toBe(0)
  await $.session.measure(at(45))
  const notes = await viaPrompt($, 65)
  expect(notes.length).toBe(1)
  expect(notes[0]).toContain('zona dura')
  expect(notes[0]).not.toContain('zona morbida')
  expect((await viaPrompt($, 50)).length).toBe(0)
  expect((await viaPrompt($, 70)).length).toBe(0)

  // Dalla dura direttamente oltre il margine.
  const [margin] = await viaPrompt($, 80)
  expect(margin).toContain('margine di sicurezza superato')
})

test('durante il turno (PostToolUse): una nota per zona per sessione, una lettura ogni 30 s al massimo', async ($, on) => {
  const { state, clock } = world(on)

  expect(await viaTool($, clock, 30, state)).toEqual([])
  const [soft, ...rest] = await viaTool($, clock, 45, state)
  expect(rest.length).toBe(0)
  expect(soft).toContain('al 45% della finestra: zona morbida')

  // Dieci secondi dopo non si legge: la dura aspetta il prossimo controllo.
  state.percent = 62
  await clock.advance(10_000)
  expect((await $.classic.PostToolUse(after)).additionalContext ?? []).toEqual([])
  const [hard] = await viaTool($, clock, 62, state)
  expect(hard).toContain('al 62% della finestra: zona dura')
  expect(await viaTool($, clock, 63, state)).toEqual([])

  const [margin] = await viaTool($, clock, 80, state)
  expect(margin).toContain('margine di sicurezza superato (soglie 40/60/75%)')
  expect(await viaTool($, clock, 85, state)).toEqual([])

  // Nuova sessione, contesto già oltre il margine: solo la nota del margine.
  state.session = 's2'
  const notes = await viaTool($, clock, 80, state)
  expect(notes.length).toBe(1)
  expect(notes[0]).toContain('margine di sicurezza superato')
})

test('i due canali si coordinano: una zona segnalata da uno non si ripete sull\'altro', async ($, on) => {
  const { state, clock } = world(on)

  // La misura mette in attesa la morbida; il PostToolUse la porta prima del prompt.
  await $.session.measure(at(45))
  expect((await viaTool($, clock, 45, state)).join(' ')).toContain('zona morbida')
  expect(((await $.prompt.submit(typed('continua'))).context ?? []).length).toBe(0)

  // La dura arriva col prompt; il PostToolUse dopo non la ripete.
  expect((await viaPrompt($, 62)).join(' ')).toContain('zona dura')
  expect(await viaTool($, clock, 62, state)).toEqual([])
})

test('dopo un compact (stessa sessione) le zone ripartono e la nota in attesa decade', async ($, on) => {
  world(on)

  expect((await viaPrompt($, 62)).join(' ')).toContain('zona dura')
  // Una misura mette in attesa il margine, poi il compact riporta giù il contesto.
  await $.session.measure(at(80))
  await $.classic.SessionStart({ source: 'compact' })
  expect(((await $.prompt.submit(typed('continua'))).context ?? []).length).toBe(0)

  // Stessa sessione: la morbida torna a essere segnalata, una volta sola.
  expect((await viaPrompt($, 45)).join(' ')).toContain('zona morbida')
  expect((await viaPrompt($, 50)).length).toBe(0)
})

test('il margine cita l\'auto-compact che /context riporta, o che è spento', async ($, on) => {
  const { state, clock } = world(on)
  const breakdown = (isAutoCompactEnabled: boolean) =>
    ({ isAutoCompactEnabled, autoCompactThreshold: isAutoCompactEnabled ? 930_000 : undefined }) as unknown as SessionContextBreakdown

  state.breakdown = breakdown(true)
  expect((await viaTool($, clock, 80, state)).join(' ')).toContain("l'auto-compact scatta al 93%.")

  state.session = 's2'
  state.breakdown = breakdown(false)
  expect((await viaPrompt($, 80)).join(' ')).toContain("l'auto-compact è spento in questa sessione.")
})

test('monitor spento (morbida 0): nessuna nota su nessun canale', { options: { threshold: 0 } }, async ($, on) => {
  const { state, clock } = world(on)

  expect((await viaPrompt($, 90)).length).toBe(0)
  expect(await viaTool($, clock, 90, state)).toEqual([])
})

test('context_usage risponde con una riga per ogni zona', async ($, on) => {
  const { state } = world(on)
  const line = async (percent: number | undefined) => {
    state.percent = percent
    return (await $.tool.call({ tool: TOOL })).result
  }

  expect(await line(undefined)).toBe('contesto non ancora misurato (40/60%)')
  expect(await line(23)).toBe('23% · zona normale (40/60%)')
  expect(await line(47)).toBe('47% · zona morbida (40/60%)')
  expect(await line(63)).toBe('63% · zona dura (40/60%)')
  expect(await line(78)).toBe('78% · margine di sicurezza superato (40/60/75%)')
})

test('context_usage con soglie da /config: la dura in vigore è almeno morbida + 10', { options: { threshold: 55, hardThreshold: 60 } }, async ($, on) => {
  const { state } = world(on)

  // Con la dura di /config (60%) il 62% sarebbe zona dura; in vigore è al 65%.
  state.percent = 62
  expect((await $.tool.call({ tool: TOOL })).result).toBe('62% · zona morbida (55/65%)')
  state.percent = 81
  expect((await $.tool.call({ tool: TOOL })).result).toBe('81% · margine di sicurezza superato (55/65/80%)')
})

test('context_usage col monitor spento', { options: { threshold: 0 } }, async ($, on) => {
  const { state } = world(on)

  expect((await $.tool.call({ tool: TOOL })).result).toBe('monitor spento')
  state.percent = 23
  expect((await $.tool.call({ tool: TOOL })).result).toBe('23% · monitor spento')
})
