import { expect, test } from 'claude-code/testing'
import type { CommandRunInput, CommandSpec, ConfigSetInput, On, PaneOpenArgs, PromptSubmitInput, RenderPropsOf, ToolSpec } from 'claude-code'

const PLUGIN = 'auto-clear-context'
const SOFT = `${PLUGIN}.threshold`
const HARD = `${PLUGIN}.hardThreshold`
const SURFACES = ['terminal', 'desktop'] as const

// Il pannello come lo riceve il render hook: la superficie lo ha già piazzato.
const PANE: RenderPropsOf['Pane'] = {
  title: 'Soglie di contesto',
  isFocused: true,
  bodyColumns: 60,
  placement: 'inline',
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
}

const soglia = (args: string): CommandRunInput => ({
  command: 'soglia',
  args,
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 120 },
})

const typed = (text: string): PromptSubmitInput => ({ text, wait: false, origin: { kind: 'composer' } })

const START = { cwd: 'C:/progetto', surface: 'terminal', isInteractive: true } as const

// Il mondo sotto la mod: le righe di /config delle due soglie (come le elenca il
// motore per un plugin caricato da cartella, o assenti come in una sessione
// headless), lo store della mod, il contesto su una finestra da 1M, i config.set
// ricevuti, i toast e i pannelli aperti. `onSet` gira prima che config.set scriva.
const world = (
  on: On,
  setup: {
    prefix?: string
    deny?: string
    hasRows?: boolean
    store?: Record<string, unknown>
    onSet?: (e: ConfigSetInput) => Promise<void>
  } = {},
) => {
  const state = {
    values: { threshold: 40, hardThreshold: 60 } as Record<string, number>,
    sets: [] as ConfigSetInput[],
    toasts: [] as string[],
    opened: [] as PaneOpenArgs[],
    store: new Map(Object.entries(setup.store ?? {})),
  }
  const prefix = setup.prefix ?? PLUGIN
  const provider = { plugin: `${PLUGIN}@inline`, tier: 'user' } as const
  const row = (field: string, label: string) =>
    ({ key: `${prefix}.${field}`, label, kind: 'number', value: state.values[field] ?? 0, provider, isLocked: false }) as const
  on('config.list', () => ({
    value: setup.hasRows === false ? [] : [row('threshold', 'Soglia morbida (%)'), row('hardThreshold', 'Soglia dura (%)')],
  }))
  on('config.set', async (_, e) => {
    state.sets.push(e)
    if (setup.deny !== undefined) return { deny: setup.deny }
    await setup.onSet?.(e)
    state.values[e.key.slice(e.key.lastIndexOf('.') + 1)] = Number(e.value)
    return { value: e.value }
  })
  on('store.get', (_, e) => ({ value: state.store.get(e.key) }))
  on('store.set', (_, e) => {
    state.store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    state.store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...state.store.keys()] }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 1_000_000, tokens: 120_000, percent: 12 }, rateLimits: [] },
  }))
  on('ui.toast', (_, e) => {
    state.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', (_, e) => {
    state.opened.push(e)
    return { value: { isPlaced: true } }
  })
  return state
}

// Le registrazioni di session.start.
const registrar = (on: On) => {
  const registered = { commands: [] as CommandSpec[], tools: [] as ToolSpec[] }
  on('command.register', (_, e) => {
    registered.commands.push(e)
    return { value: { command: e.name } }
  })
  on('tool.register', (_, e) => {
    registered.tools.push(e)
    return { value: { tool: `mcp__${PLUGIN}__${e.name}` } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return registered
}

// Quello che serve al monitor: la sessione, i file del log, il fondo di misure e prompt.
const monitor = (on: On) => {
  on('session.id', () => ({ value: 's1' }))
  on('session.root', () => ({ value: 'C:/progetto' }))
  on('fs.read', (_, e) => ({ deny: `ENOENT ${e.path}` }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.stat', (_, e) => ({ deny: `ENOENT ${e.path}` }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context, origin: e.origin }))
}

const at = (percent: number) => ({ context: { window: 100, tokens: percent, percent }, rateLimits: [], changed: ['context' as const] })

test('session.start registra /soglia e il tool context_usage, in vista dal primo turno', async ($, on) => {
  const registered = registrar(on)

  await $.session.start(START)
  expect(registered.commands.map(command => command.name)).toEqual(['soglia'])
  expect(registered.tools).toEqual([expect.objectContaining({ name: 'context_usage', isDeferred: false })])
  expect(registered.tools[0]?.description).toContain('47% · zona morbida (40/60%)')
})

test('/soglia 45 con le righe di /config: config.set della morbida e conferma con i token', async ($, on) => {
  const state = world(on)

  const ran = await $.command.run(soglia('45'))
  expect(state.sets.map(set => [set.key, set.value])).toEqual([[SOFT, 45]])
  expect(ran.text).toBe('Soglia morbida impostata al 45% · 450k token (salvata nelle impostazioni).')
  expect(state.store.size).toBe(0)
  expect(state.opened.length).toBe(0)
})

test('/soglia 0 spegne il monitor; un valore uguale o non valido non scrive nulla', async ($, on) => {
  const state = world(on)

  expect((await $.command.run(soglia('40'))).text).toBe('La soglia morbida è già al 40% · 400k token.')
  expect((await $.command.run(soglia('40 60'))).text).toBe('Le soglie sono già al 40/60%.')
  for (const args of ['120', 'quaranta', 'dura', '45 65 70', 'dura 96']) {
    expect((await $.command.run(soglia(args))).text).toContain('non è una soglia valida')
  }
  expect(state.sets.length).toBe(0)

  expect((await $.command.run(soglia('0'))).text).toBe('Monitor di contesto spento, soglia morbida 0% (salvata nelle impostazioni).')
  expect(state.sets.map(set => [set.key, set.value])).toEqual([[SOFT, 0]])
  expect((await $.command.run(soglia('off'))).text).toBe('Il monitor è già spento (soglia morbida 0%).')
  expect(state.sets.length).toBe(1)
})

test('con le righe di /config e un override, config.set riesce e l\'override sparisce', async ($, on) => {
  const state = world(on, { store: { threshold: 30 } })

  const ran = await $.command.run(soglia('45'))
  expect(state.sets.map(set => [set.key, set.value])).toEqual([[SOFT, 45]])
  expect(state.store.has('threshold')).toBe(false)
  expect(ran.text).toBe('Soglia morbida impostata al 45% · 450k token (salvata nelle impostazioni).')
})

test('la chiave viene da $.config.list; un { deny } è un errore e l\'override resta', async ($, on) => {
  const prefix = `${PLUGIN}@inline`
  const state = world(on, { prefix, deny: 'bloccata dalle impostazioni gestite', store: { threshold: 30 } })
  registrar(on)

  const ran = await $.command.run(soglia('50'))
  expect(state.sets.map(set => [set.key, set.value])).toEqual([[`${prefix}.threshold`, 50]])
  expect(ran.text).toBe('Soglia morbida non cambiata: bloccata dalle impostazioni gestite')
  expect(state.store.get('threshold')).toBe(30)

  // Con due valori il primo rifiuto (qui la dura, che si alza per prima) ferma
  // la coppia, e nessuna scrittura resta in sospeso per un modulo ricaricato.
  const pair = await $.command.run(soglia('35 70'))
  expect(state.sets.map(set => set.key)).toEqual([`${prefix}.threshold`, `${prefix}.hardThreshold`])
  expect(pair.text).toBe('Soglie non cambiate: bloccata dalle impostazioni gestite')
  await $.session.start(START)
  expect(state.sets.length).toBe(2)
})

test('senza le righe di /config le soglie vanno nello store e il monitor le usa subito', async ($, on) => {
  const state = world(on, { hasRows: false })
  monitor(on)

  // Sotto i 40 di /config: nessuna segnalazione.
  await $.session.measure(at(37))
  expect(((await $.prompt.submit(typed('prima'))).context ?? []).length).toBe(0)

  const ran = await $.command.run(soglia('35'))
  expect(ran.text).toBe('Soglia morbida impostata al 35% · 350k token (salvata dalla mod; /config mostra ancora 40%).')
  expect(state.store.get('threshold')).toBe(35)
  expect(state.sets.length).toBe(0)

  // Sopra l'override (35) ma sotto i 40 di /config: ora segnala.
  await $.session.measure(at(37))
  const note = ((await $.prompt.submit(typed('dopo'))).context ?? []).join(' ')
  expect(note).toContain('al 37% della finestra: zona morbida (soglie 35/60%')

  expect((await $.command.run(soglia('dura 70'))).text).toBe(
    'Soglia dura impostata al 70% · 700k token (salvata dalla mod; /config mostra ancora 60%).',
  )
  expect(state.store.get('hardThreshold')).toBe(70)

  // Tornare ai valori di /config toglie gli override invece di duplicarli.
  expect((await $.command.run(soglia('40 60'))).text).toBe(
    'Soglie impostate: morbida 40% · 400k token, dura 60% · 600k token (vale di nuovo /config).',
  )
  expect(state.store.size).toBe(0)
  expect(state.sets.length).toBe(0)
})

test('/soglia N M scrive le due righe nell\'ordine che tiene valida la coppia intermedia', async ($, on) => {
  const state = world(on)
  registrar(on)

  // Alzando la morbida si scrive prima la dura: 40/65, poi 45/65.
  const up = await $.command.run(soglia('45 65'))
  expect(state.sets.map(set => [set.key, set.value])).toEqual([[HARD, 65], [SOFT, 45]])
  expect(up.text).toBe('Soglie impostate: morbida 45% · 450k token, dura 65% · 650k token (salvate nelle impostazioni).')
  // La seconda scrittura non resta in sospeso: una ripartenza non la ripete.
  await $.session.start(START)
  expect(state.sets.length).toBe(2)

  // Abbassandola, prima la morbida: 30/65, poi 30/50.
  await $.command.run(soglia('30/50'))
  expect(state.sets.slice(2).map(set => [set.key, set.value])).toEqual([[SOFT, 30], [HARD, 50]])

  // Un valore solo per nome, e una coppia con un valore già in vigore.
  expect((await $.command.run(soglia('dura 70'))).text).toBe('Soglia dura impostata al 70% · 700k token (salvata nelle impostazioni).')
  expect((await $.command.run(soglia('morbida 35'))).text).toBe('Soglia morbida impostata al 35% · 350k token (salvata nelle impostazioni).')
  await $.command.run(soglia('35 80'))
  expect(state.sets.slice(4).map(set => [set.key, set.value])).toEqual([[HARD, 70], [SOFT, 35], [HARD, 80]])
  expect(state.values).toEqual({ threshold: 35, hardThreshold: 80 })
})

test('una coppia fuori dai limiti si rifiuta col valore valido più vicino, senza toccare l\'altro', async ($, on) => {
  const state = world(on)

  expect((await $.command.run(soglia('55'))).text).toBe(
    'La soglia morbida resta almeno 10 punti sotto la dura (60%): il valore valido più vicino è 50%; /soglia 55 65 le cambia insieme.',
  )
  expect((await $.command.run(soglia('50 55'))).text).toBe(
    'La soglia dura va da morbida + 10 a 95%: con la morbida al 50% il valore valido più vicino è 60%.',
  )
  expect((await $.command.run(soglia('dura 45'))).text).toBe(
    'La soglia dura va da morbida + 10 a 95%: con la morbida al 40% il valore valido più vicino è 50%.',
  )
  expect((await $.command.run(soglia('90'))).text).toBe(
    'La soglia morbida va da 1 a 85% (0 spegne il monitor): il valore valido più vicino è 85%.',
  )
  expect((await $.command.run(soglia('90 95'))).text).toContain('il valore valido più vicino è 85%')
  expect(state.sets.length).toBe(0)

  // Il limite stesso è valido.
  await $.command.run(soglia('85 95'))
  expect(state.values).toEqual({ threshold: 85, hardThreshold: 95 })
})

test('con la ricarica tra le due scritture la seconda la completa session.start, una volta sola', async ($, on) => {
  registrar(on)
  let reached = () => {}
  let release = () => {}
  const isReached = new Promise<void>(resolve => (reached = resolve))
  const gate = new Promise<void>(resolve => (release = resolve))
  // La prima config.set resta in volo finché il "modulo ricaricato" non è partito.
  const state = world(on, {
    onSet: async e => {
      if (e.key !== HARD) return
      reached()
      await gate
    },
  })

  const running = $.command.run(soglia('45 65'))
  await isReached
  await $.session.start(START)
  expect(state.sets.map(set => [set.key, set.value])).toEqual([[HARD, 65], [SOFT, 45]])
  expect(state.toasts).toEqual(['Soglia morbida impostata al 45% · 450k token (salvata nelle impostazioni).'])
  release()

  // Il modulo che ha lasciato la scrittura non la ripete.
  const ran = await running
  expect(state.sets.length).toBe(2)
  expect(ran.text).toBe('Soglie impostate: morbida 45% · 450k token, dura 65% · 650k token (salvate nelle impostazioni).')

  // Nessuna scrittura resta in sospeso: un'altra ripartenza non scrive nulla.
  await $.session.start(START)
  expect(state.sets.length).toBe(2)
})

test('un esito che non vale più per le soglie in vigore sparisce dal pannello', async ($, on) => {
  const state = world(on)
  on('session.measure', (_, e) => ({ changed: e.changed }))
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'soglia', props: PANE })
  const redraw = () => $.session.measure({ context: { window: 1_000_000 }, rateLimits: [], changed: ['context'] })

  await ui.press({ key: 'preset-40' })
  expect(await ui.find({ type: 'Text', text: 'La soglia morbida è già al 40%' })).toBeDefined()

  // Un'altra sessione mette l'override della morbida al 30%; la misura ridisegna il pannello.
  state.store.set('threshold', 30)
  await redraw()
  expect((await ui.find({ type: 'Text', text: 'Soglia morbida:' }))?.text).toBe('Soglia morbida: 30% · 300k token')
  expect(await ui.find({ type: 'Text', text: 'La soglia morbida è già al 40%' })).toBeUndefined()

  // Lo stesso per la dura.
  await ui.press({ key: 'preset-30' })
  expect(await ui.find({ type: 'Text', text: 'La soglia morbida è già al 30%' })).toBeDefined()
  state.store.set('hardThreshold', 70)
  await redraw()
  expect((await ui.find({ type: 'Text', text: 'Soglia dura:' }))?.text).toBe('Soglia dura: 70% · 700k token')
  expect(await ui.find({ type: 'Text', text: 'La soglia morbida è già al 30%' })).toBeUndefined()
  expect(state.sets.length).toBe(0)
})

test('/soglia senza argomenti apre il pannello con la tastiera', async ($, on) => {
  const state = world(on)

  const ran = await $.command.run(soglia(''))
  expect(state.opened).toEqual([expect.objectContaining({ id: 'soglia', focus: true, closeOnEscape: true, rows: 20 })])
  expect(ran.text).toBeUndefined()
  expect(state.sets.length).toBe(0)
})

// Un test per superficie: il kit non ricarica il modulo dopo config.set, e la
// soglia appena scritta resta quella in vigore per il resto del test.
for (const surface of SURFACES) {
  test(`il pannello su ${surface}: soglie, zona e selettore; preset e ±5 sul valore in modifica`, async ($, on) => {
    const state = world(on)
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'soglia', props: PANE })
    const text = async (start: string) => (await ui.find({ type: 'Text', text: start }))?.text
    const has = async (key: string) => (await ui.find({ key })) !== undefined
    expect(await text('Soglia morbida:')).toBe('Soglia morbida: 40% · 400k token')
    expect(await text('Soglia dura:')).toBe('Soglia dura: 60% · 600k token')
    expect(await text('Margine di sicurezza:')).toBe('Margine di sicurezza: 75% · 750k token (dura + 15)')
    expect(await text('Contesto ora')).toBe('Contesto ora: 120k token (12%) · zona normale')
    expect((await ui.find({ key: 'target' }))?.text).toBe('In modifica: morbida · passa alla dura')
    expect((await ui.find({ key: 'preset-30' }))?.text).toContain('30% · 300k token')
    // Con la dura al 60% la morbida arriva al 50%: i preset oltre non ci sono.
    expect([await has('preset-0'), await has('preset-50'), await has('preset-60'), await has('preset-80')]).toEqual([true, true, false, false])
    expect(await ui.find({ type: 'Text', text: '← attuale' })).toBeDefined()
    expect(await has('reset')).toBe(false)
    expect(await text('Valori liberi')).toBe(
      surface === 'terminal' ? 'Valori liberi: /soglia N M (morbida e dura) · Esc chiude' : 'Valori liberi: /soglia N M (morbida e dura)',
    )
    // Ogni pulsante ha il suo tasto, senza collisioni.
    const hotkeys = (await ui.findAll({ type: 'Button' })).map(button => button.props.hotkey)
    expect(hotkeys).toEqual(['t', '0', '3', '4', '5', 'm', 'p'])

    await ui.press({ key: 'preset-30' })
    expect(state.sets.map(set => [set.key, set.value])).toEqual([[SOFT, 30]])
    expect(state.toasts.at(-1)).toBe('Soglia morbida impostata al 30% · 300k token (salvata nelle impostazioni).')
    expect(await ui.find({ type: 'Text', text: 'impostata al 30%' })).toBeDefined()
    await ui.press({ key: 'up' })
    expect(state.sets.map(set => set.value)).toEqual([30, 35])

    // Il selettore passa alla dura: preset e passi agiscono su di lei.
    await ui.press({ key: 'target' })
    expect((await ui.find({ key: 'target' }))?.text).toBe('In modifica: dura · passa alla morbida')
    expect([await has('preset-0'), await has('preset-50'), await has('preset-90')]).toEqual([false, true, true])
    await ui.press({ key: 'preset-80' })
    await ui.press({ key: 'down' })
    expect(state.sets.slice(2).map(set => [set.key, set.value])).toEqual([[HARD, 80], [HARD, 75]])
    expect(await text('Soglia dura:')).toBe('Soglia dura: 75% · 750k token')
    expect(await text('Margine di sicurezza:')).toBe('Margine di sicurezza: 90% · 900k token (dura + 15)')

    // E torna alla morbida, che ora arriva al 65%.
    await ui.press({ key: 'target' })
    expect([await has('preset-60'), await has('preset-70')]).toEqual([true, false])
    await ui.unmount()
  })

  test(`il pannello su ${surface} con gli override: mostra /config e «Ripristina /config» li toglie`, async ($, on) => {
    const state = world(on, { hasRows: false, store: { threshold: 30, hardThreshold: 70 } })
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'soglia', props: PANE })
    const text = async (start: string) => (await ui.find({ type: 'Text', text: start }))?.text
    expect(await text('Soglia morbida:')).toBe('Soglia morbida: 30% · 300k token')
    expect(await text('Soglia dura:')).toBe('Soglia dura: 70% · 700k token')
    expect(await text('Salvate dalla mod')).toBe('Salvate dalla mod; in /config restano 40/60%')
    expect((await ui.find({ key: 'reset' }))?.text).toBe('Ripristina /config (40/60%)')

    await ui.press({ key: 'reset' })
    expect(state.store.size).toBe(0)
    expect(state.toasts.at(-1)).toBe('Override della mod tolti: vale /config, morbida 40% · 400k token, dura 60% · 600k token.')
    expect(await text('Soglia morbida:')).toBe('Soglia morbida: 40% · 400k token')
    expect(await ui.find({ key: 'reset' })).toBeUndefined()
    expect(state.sets.length).toBe(0)
    await ui.unmount()
  })
}
