import { atom, read, update } from 'claude-code'
import type { ConfigRow, EngineInterface, Register, SessionUsage } from 'claude-code'

import type { ThresholdField, ThresholdNotice, ThresholdWrite, ThresholdZone } from '../types'

// Vicino alle soglie di contesto Claude salva lo stato in un handoff validato
// (skill auto-clear-context:handoff); a fine turno la mod esegue /clear e, nella
// sessione pulita, allega l'handoff e fa ripartire il turno da sola.
//
// Zone: normale, morbida (handoff al prossimo punto naturale), dura (al primo
// punto sicuro) e margine di sicurezza, dura + 15 (subito). La dura in vigore
// sta almeno 10 punti sopra la morbida; morbida 0 spegne il monitor.
// Monitor: session.measure dopo ogni turno (nota allegata al prossimo prompt) e
// classic.PostToolUse durante i turni lunghi (una lettura ogni CHECK_EVERY_MS al
// massimo); una nota per zona per sessione, la zona già segnalata in $.state.
// Dopo un compact (stessa sessione, contesto di nuovo basso) le zone ripartono.
// Tool context_usage (mcp__auto-clear-context__context_usage): percentuale e zona
// su richiesta, in una riga.
// Clear: turn.complete con .claude/handoff/pending.md in stato "validated".
// Ripresa: session.end (clear) invia il prompt di ripresa; classic.SessionStart
// (clear|compact) allega l'handoff validato e lo archivia.
// Soglie: /soglia apre un pannello (valore in modifica, preset e −5/+5),
// /soglia 45 imposta la morbida, /soglia 45 65 morbida e dura. Con le righe di
// /config la scrittura va nelle impostazioni e il motore ricarica il modulo con
// le nuove options: con due valori la seconda scrittura aspetta in $.state e, se
// la ricarica ferma questo modulo prima, la completa quello nuovo in session.start.
// Dove /config non ha le righe (sessioni headless, tab Code dell'app) le salva la
// mod in $.store. Il monitor legge le soglie in vigore a ogni controllo.

type Handoff = { text: string; status: string; id: string }
type ClearRecord = { at: number; handoff: string }
type Field = ThresholdField
type Pair = Record<Field, number>
type Limits = { soft: number; hard: number; margin: number }
type Settings = { inForce: Pair; inConfig: Pair; overrides: Partial<Pair> }
type Saved = { field: Field; value: number; via: 'config' | 'store' | 'restored' }
type Refused = { field: Field; value: number; deny: string }

const HANDOFF_DIR = '.claude/handoff'
const CHECK_EVERY_MS = 30_000
const HOUR_MS = 3_600_000
const RETRY_MS = 300
const CLEARS_KEY = 'clears'
const CLEARS_KEPT = 20
const EVENTS_KEPT = 300
const BUSY = ['pending', 'running', 'waiting']

const PANE = 'soglia'
const PANE_ROWS = 20
// Campi di userConfig e chiavi degli override in $.store hanno lo stesso nome.
const FIELDS: readonly Field[] = ['threshold', 'hardThreshold']
const LABELS: Record<Field, string> = { threshold: 'morbida', hardThreshold: 'dura' }
const DEFAULTS: Pair = { threshold: 40, hardThreshold: 60 }
const PRESETS: Record<Field, readonly number[]> = { threshold: [0, 30, 40, 50, 60, 70, 80], hardThreshold: [50, 60, 70, 80, 90] }
const STEP = 5
const MAX_SOFT = 85
const MAX_THRESHOLD = 95
const HARD_GAP = 10
const MARGIN_GAP = 15
const AUTO_COMPACT_PERCENT = 97
const ZONE_NAMES = ['zona normale', 'zona morbida', 'zona dura', 'margine di sicurezza superato'] as const

const CONTEXT_TOOL_NAME = 'context_usage'
const CONTEXT_TOOL = 'mcp__auto-clear-context__context_usage'
const CONTEXT_TOOL_DESCRIPTION = [
  'Legge quanto è pieno il contesto della sessione e la zona della mod auto-clear-context',
  '(normale, morbida, dura, margine di sicurezza superato) con le soglie in vigore.',
  'Risponde con una riga, per esempio "47% · zona morbida (40/60%)". Sola lettura, nessun argomento.',
].join(' ')

const RESUME = [
  'Ripresa automatica della mod auto-clear-context: il /clear è stato eseguito dopo un handoff validato.',
  `L'handoff è allegato al contesto di questa sessione, con una copia in ${HANDOFF_DIR}/archive/.`,
  "Il lavoro riprende dal prossimo passo indicato nell'handoff, dopo aver riletto i file che elenca.",
].join(' ')

const USAGE = [
  '/soglia N imposta la morbida (1-85; 0 o spento spengono il monitor),',
  '/soglia N M morbida e dura (dura da morbida + 10 a 95),',
  '/soglia morbida N e /soglia dura N una sola, /soglia da solo apre il pannello.',
].join(' ')

// Le regole che le note riportano in breve.
const NATURAL_POINTS = [
  'un sotto-task finito e verificato (test verdi o build ok)',
  'il risultato di un subagent appena integrato',
  'prima di aprire un file nuovo o di iniziare una feature o un sotto-task nuovo',
  "la fine di una risposta all'utente quando il passo dopo è un argomento nuovo",
].join('; ')
const NEVER_POINTS = [
  'a metà di un edit o con modifiche su più file non ancora coerenti',
  'a metà di un debug (ipotesi in prova, test rossi non spiegati)',
  'con lavoro in background attivo',
  "con una richiesta di permesso o una domanda all'utente in sospeso",
].join('; ')
const HOW = [
  `L'handoff lo prepara la skill auto-clear-context:handoff, che salva lo stato in ${HANDOFF_DIR}/pending.md e lo fa validare da un subagent;`,
  "con l'handoff validato e nessun lavoro in background, a fine turno la mod esegue /clear e il lavoro riparte da solo nella sessione pulita.",
  `Percentuale e zona si leggono su richiesta con il tool ${CONTEXT_TOOL}.`,
].join(' ')

// "40/60%", con il margine "40/60/75%".
const levels = (limits: Limits, withMargin = false) => `${limits.soft}/${limits.hard}${withMargin ? `/${limits.margin}` : ''}%`

// La nota che la mod allega quando il contesto entra in una zona.
const zoneNote = (zone: ThresholdZone, percent: number, limits: Limits, autoCompact: number | undefined) => {
  const seen = `La mod auto-clear-context rileva il contesto al ${percent}% della finestra`
  const levelsText = `soglie ${levels(limits)}, margine di sicurezza al ${limits.margin}%`
  if (zone === 3) {
    const compact = autoCompact === undefined ? "l'auto-compact è spento in questa sessione" : `l'auto-compact scatta al ${autoCompact}%`
    return [
      `${seen}: margine di sicurezza superato (soglie ${levels(limits, true)}); ${compact}.`,
      "In questa zona l'handoff è previsto subito, anche fuori dai punti sicuri: il lavoro rimasto a metà va nella sezione «Lavoro interrotto» dell'handoff.",
      HOW,
    ].join(' ')
  }
  if (zone === 2) {
    return [
      `${seen}: zona dura (${levelsText}).`,
      "In questa zona l'handoff è previsto al primo punto sicuro: si completa l'azione atomica in corso e non se ne iniziano altre.",
      `Non sono punti sicuri: ${NEVER_POINTS}.`,
      "Se resta un debug aperto o ci sono test rossi, l'handoff aggiunge la sezione «Lavoro interrotto».",
      HOW,
    ].join(' ')
  }
  return [
    `${seen}: zona morbida (${levelsText}).`,
    `In questa zona l'handoff è previsto al prossimo punto naturale: ${NATURAL_POINTS}.`,
    `Non sono punti adatti: ${NEVER_POINTS}.`,
    HOW,
  ].join(' ')
}

const attached = (handoff: Handoff, archived: string) =>
  `Handoff della sessione precedente, validato e allegato dalla mod auto-clear-context (copia in ${archived}):\n\n${handoff.text}`

// L'esito dell'ultima modifica delle soglie: in $.state, perché la scrittura
// ricarica il modulo e il pannello deve ancora mostrarlo dopo.
const notice = atom({ plugin: 'auto-clear-context', key: 'thresholdNotice' } as const, null)
// Il valore che il pannello modifica (tasto t nel terminale, pulsante nell'app).
const paneTarget = atom({ plugin: 'auto-clear-context', key: 'paneTarget' } as const, 'threshold')
// Per session id, la zona più alta già segnalata a Claude.
const SIGNALED = { plugin: 'auto-clear-context', key: 'signaledZone' } as const
// La seconda scrittura in /config di una coppia, finché qualcuno non la prende.
const PENDING_WRITE = { plugin: 'auto-clear-context', key: 'pendingWrite' } as const

let pendingNote: { session: string; zone: ThresholdZone; text: string } | undefined
let lastCheckAt = 0
let isClearRequested = false
let isExcludeChecked = false
let logChain: Promise<void> = Promise.resolve()
// Le soglie che questo modulo ha scritto in /config: valgono finché il motore non
// lo ricarica con le nuove options (o se non lo ricarica).
const configApplied: Partial<Pair> = {}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

// In un .tsx `<T,>` distingue il generico da un tag JSX.
const orElse = <T,>(read: Promise<T>, fallback: T) => read.catch(() => fallback)

const paths = async ($: EngineInterface) => {
  const root = (await $.session.root()).replace(/[\\/]+$/, '')
  const dir = `${root}/${HANDOFF_DIR}`
  return { root, pending: `${dir}/pending.md`, archive: `${dir}/archive`, events: `${dir}/events.log` }
}

const readText = async ($: EngineInterface, path: string) => {
  const read = await orElse($.fs.read(path), '')
  return typeof read === 'string' ? read : ''
}

// Impronta breve del testo (FNV-1a a 32 bit più la lunghezza): riconosce lo
// stesso handoff tra un turno e l'altro.
const fingerprint = (text: string) => {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${hash.toString(16).padStart(8, '0')}${text.length.toString(16)}`
}

// .claude/handoff/ resta fuori da git: la mod lo aggiunge a .git/info/exclude,
// che è locale e non finisce in nessun commit.
const ensureExcluded = async ($: EngineInterface) => {
  if (isExcludeChecked) return
  isExcludeChecked = true
  const { root } = await paths($)
  const git = await orElse($.fs.stat(`${root}/.git`), undefined)
  if (git?.kind !== 'dir') return
  const exclude = `${root}/.git/info/exclude`
  const current = await readText($, exclude)
  if (/^\/?\.claude\/handoff\/?\s*$/m.test(current)) return
  const separator = current === '' || current.endsWith('\n') ? '' : '\n'
  await $.fs.write(exclude, `${current}${separator}${HANDOFF_DIR}/\n`)
}

const log = ($: EngineInterface, text: string) => {
  $.ui.log(`auto-clear-context: ${text}`)
  logChain = logChain
    .then(async () => {
      await ensureExcluded($)
      const { events } = await paths($)
      const at = new Date(await $.clock.now()).toISOString()
      const kept = (await readText($, events)).split('\n').filter(line => line !== '').slice(1 - EVENTS_KEPT)
      await $.fs.write(events, `${[...kept, `${at} ${text}`].join('\n')}\n`)
    })
    .catch(() => undefined)
}

const readPending = async ($: EngineInterface): Promise<Handoff | undefined> => {
  const text = await readText($, (await paths($)).pending)
  if (text.trim() === '') return undefined
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? ''
  const status = /^status:\s*(\S+)/m.exec(front)?.[1] ?? 'draft'
  return { text, status, id: fingerprint(text) }
}

// $.fs non cancella: l'handoff si copia in archive/ e pending.md resta vuoto.
const archive = async ($: EngineInterface, handoff: Handoff) => {
  await ensureExcluded($)
  const { pending, archive: dir } = await paths($)
  const stamp = new Date(await $.clock.now()).toISOString().replace(/[:.]/g, '-')
  const name = `${stamp}-${handoff.id}.md`
  await $.fs.write(`${dir}/${name}`, handoff.text)
  await $.fs.write(pending, '')
  return `${HANDOFF_DIR}/archive/${name}`
}

const runClear = ($: EngineInterface, canRetry: boolean) => {
  $.command.run({ command: 'clear' }).then(
    () => undefined,
    error => {
      if (canRetry) {
        $.clock.after(RETRY_MS, () => runClear($, false))
        return
      }
      isClearRequested = false
      log($, `/clear non eseguito: ${errorText(error)}`)
    },
  )
}

// 1.000.000 → "1M", 450.000 → "450k".
const formatTokens = (tokens: number) => {
  if (tokens >= 999_500) return `${String(Math.round(tokens / 100_000) / 10).replace('.', ',')}M`
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`
  return String(Math.round(tokens))
}

// "50% · 500k token" sulla finestra del modello; senza finestra nota, "50%".
const describeThreshold = (percent: number, window: number | undefined) => {
  if (percent <= 0) return '0% · monitor spento'
  if (window === undefined) return `${percent}%`
  return `${percent}% · ${formatTokens((window * percent) / 100)} token`
}

// Le soglie in vigore: la dura almeno morbida + 10, il margine dura + 15, mai oltre il 95%.
const limitsOf = (pair: Pair): Limits => {
  const soft = pair.threshold
  const hard = Math.min(MAX_THRESHOLD, Math.max(pair.hardThreshold, soft + HARD_GAP))
  return { soft, hard, margin: Math.min(MAX_THRESHOLD, hard + MARGIN_GAP) }
}

const zoneOf = (percent: number, limits: Limits): ThresholdZone => {
  if (limits.soft <= 0 || percent < limits.soft) return 0
  if (percent >= limits.margin) return 3
  return percent >= limits.hard ? 2 : 1
}

const describeUsage = (usage: SessionUsage | undefined, limits: Limits) => {
  if (usage === undefined) return 'Contesto ora: non disponibile'
  const { tokens, percent, window } = usage.context
  if (tokens === undefined) return `Contesto ora: non ancora misurato · finestra da ${formatTokens(window)} token`
  const where = limits.soft <= 0 ? ' · monitor spento' : percent === undefined ? '' : ` · ${ZONE_NAMES[zoneOf(percent, limits)]}`
  return `Contesto ora: ${formatTokens(tokens)} token${percent === undefined ? '' : ` (${percent}%)`}${where}`
}

// La riga del tool context_usage: "47% · zona morbida (40/60%)".
const usageLine = (usage: SessionUsage | undefined, limits: Limits) => {
  const percent = usage?.context.percent
  if (limits.soft <= 0) return percent === undefined ? 'monitor spento' : `${percent}% · monitor spento`
  if (usage === undefined) return `contesto non disponibile (${levels(limits)})`
  if (percent === undefined) return `contesto non ancora misurato (${levels(limits)})`
  const zone = zoneOf(percent, limits)
  return `${percent}% · ${ZONE_NAMES[zone]} (${levels(limits, zone === 3)})`
}

// −5/+5 sui multipli di 5 (47 → 45 o 50), tra 0 e 95.
const stepThreshold = (percent: number, delta: number) => {
  const base = delta > 0 ? Math.floor(percent / STEP) * STEP : Math.ceil(percent / STEP) * STEP
  return Math.min(MAX_THRESHOLD, Math.max(0, base + delta))
}

// I valori che un campo può prendere con l'altro fermo.
const boundsOf = (field: Field, pair: Pair) =>
  field === 'threshold'
    ? { min: 0, max: Math.min(MAX_SOFT, pair.hardThreshold - HARD_GAP) }
    : { min: pair.threshold + HARD_GAP, max: MAX_THRESHOLD }

// "45", "45%", "0", "spento" o "off"; undefined per tutto il resto.
const parseThreshold = (text: string) => {
  if (/^(spento|spenta|off)$/i.test(text)) return 0
  const percent = Number(/^(\d{1,3})\s*%?$/.exec(text)?.[1] ?? Number.NaN)
  return percent <= MAX_THRESHOLD ? percent : undefined
}

// Gli argomenti di /soglia: "45" (morbida), "45 65" o "45/65" (morbida e dura),
// "morbida 45", "dura 65"; undefined per tutto il resto.
const parseRequest = (text: string): Partial<Pair> | undefined => {
  const words = text.toLowerCase().split(/[\s/]+/)
  const [first = '', second] = words
  if (words.length > 2) return undefined
  if (second !== undefined && (first === 'morbida' || first === 'dura')) {
    const value = parseThreshold(second)
    if (value === undefined) return undefined
    return first === 'morbida' ? { threshold: value } : { hardThreshold: value }
  }
  const soft = parseThreshold(first)
  if (soft === undefined) return undefined
  if (second === undefined) return { threshold: soft }
  const hard = parseThreshold(second)
  return hard === undefined ? undefined : { threshold: soft, hardThreshold: hard }
}

const nearestText = (percent: number) => (percent === 0 ? '0 (monitor spento)' : `${percent}%`)

// Una coppia fuori dai limiti si rifiuta indicando il valore valido più vicino
// del campo chiesto; l'altro valore non si tocca.
const checkPair = (pair: Pair, asked: readonly Field[]) => {
  const soft = pair.threshold
  const hard = pair.hardThreshold
  if (soft > MAX_SOFT) return `La soglia morbida va da 1 a ${MAX_SOFT}% (0 spegne il monitor): il valore valido più vicino è ${MAX_SOFT}%.`
  if (hard >= soft + HARD_GAP) return undefined
  if (asked.includes('hardThreshold')) {
    const nearest = Math.min(MAX_THRESHOLD, Math.max(hard, soft + HARD_GAP))
    return `La soglia dura va da morbida + ${HARD_GAP} a ${MAX_THRESHOLD}%: con la morbida al ${soft}% il valore valido più vicino è ${nearest}%.`
  }
  const nearest = Math.max(0, Math.min(MAX_SOFT, hard - HARD_GAP))
  return `La soglia morbida resta almeno ${HARD_GAP} punti sotto la dura (${hard}%): il valore valido più vicino è ${nearestText(nearest)}; /soglia ${soft} ${soft + HARD_GAP} le cambia insieme.`
}

// La riga di /config di un campo: `<plugin>.<campo>`, oppure
// `<plugin>@<origine>.<campo>` se due plugin caricati hanno lo stesso nome.
const findRow = (rows: readonly ConfigRow[], name: string, field: Field) =>
  rows.find(row => row.key === `${name}.${field}`) ??
  rows.find(row => row.key.startsWith(`${name}@`) && row.key.endsWith(`.${field}`))

const readUsage = ($: EngineInterface) => orElse<SessionUsage | undefined>($.session.usage(), undefined)

// La percentuale a cui scatta l'auto-compact, dal breakdown di /context (stima
// locale, nessuna richiesta): undefined se è spento, AUTO_COMPACT_PERCENT se il
// motore non la dà.
const readAutoCompact = async ($: EngineInterface) => {
  const usage = await orElse<SessionUsage | undefined>($.session.usage({ breakdown: 'summary' }), undefined)
  const breakdown = usage?.context.breakdown
  if (usage === undefined || breakdown === undefined) return AUTO_COMPACT_PERCENT
  if (!breakdown.isAutoCompactEnabled) return undefined
  const at = breakdown.autoCompactThreshold
  if (at === undefined || usage.context.window <= 0) return AUTO_COMPACT_PERCENT
  return Math.min(100, Math.round((at * 100) / usage.context.window))
}

const buildNote = async ($: EngineInterface, zone: ThresholdZone, percent: number, limits: Limits) =>
  zoneNote(zone, percent, limits, zone === 3 ? await readAutoCompact($) : AUTO_COMPACT_PERCENT)

const readSignaled = async ($: EngineInterface, session: string) =>
  (await orElse(read($, { ...SIGNALED, id: session }), undefined)) ?? 0

// Segna la zona come segnalata nella sessione; false se lo era già, anche per
// una lettura parallela arrivata prima (scrittura con ifVersion).
const markSignaled = async ($: EngineInterface, session: string, zone: ThresholdZone) => {
  const ref = { ...SIGNALED, id: session }
  const { value = 0, version } = await $.state.get(ref)
  if (value >= zone) return false
  return (await $.state.set(ref, zone, { ifVersion: version })).isSet
}

// Dopo un compact la sessione resta la stessa ma il contesto riparte basso: le
// zone tornano da segnalare e una nota in attesa non vale più.
const resetSignaled = async ($: EngineInterface) => {
  pendingNote = undefined
  await $.state.set({ ...SIGNALED, id: await $.session.id() }, 0)
}

// L'override che la mod salva in $.store dove /config non può scrivere un campo:
// vale subito e in ogni sessione, finché /config non torna a decidere.
const readOverride = async ($: EngineInterface, field: Field) => {
  const value = await orElse($.store.get(field), undefined)
  return typeof value === 'number' && value >= 0 && value <= MAX_THRESHOLD ? value : undefined
}

// Le soglie di /config come le usa il monitor: quelle appena scritte da questo
// modulo, altrimenti le options con cui è stato caricato.
const fromConfig = (configured: Pair): Pair => ({
  threshold: configApplied.threshold ?? configured.threshold,
  hardThreshold: configApplied.hardThreshold ?? configured.hardThreshold,
})

// Le soglie in vigore, lette a ogni controllo: l'override, poi /config.
const readSettings = async ($: EngineInterface, configured: Pair): Promise<Settings> => {
  const [threshold, hardThreshold] = await Promise.all([readOverride($, 'threshold'), readOverride($, 'hardThreshold')])
  const inConfig = fromConfig(configured)
  return {
    inForce: { threshold: threshold ?? inConfig.threshold, hardThreshold: hardThreshold ?? inConfig.hardThreshold },
    inConfig,
    overrides: { threshold, hardThreshold },
  }
}

const effectiveLimits = async ($: EngineInterface, configured: Pair) => limitsOf((await readSettings($, configured)).inForce)

// Prende la scrittura in sospeso, una volta sola anche se il modulo vecchio e
// quello ricaricato ci provano insieme.
const claimPendingWrite = async ($: EngineInterface) => {
  const { value, version } = await $.state.get(PENDING_WRITE)
  if (value === undefined || value === null) return undefined
  const { isSet } = await $.state.set(PENDING_WRITE, null, { ifVersion: version })
  return isSet ? value : undefined
}

// Salva un valore: in /config se il campo ha la riga (l'override si toglie
// prima, perché la scrittura ricarica il modulo, e torna se config.set dice no);
// altrimenti, o se config.set rifiuta la chiave, come override in $.store.
const saveField = async ($: EngineInterface, write: ThresholdWrite, inConfig: Pair): Promise<Saved | Refused> => {
  const { field, value, key, override } = write
  if (key !== undefined) {
    if (override !== undefined) await $.store.delete(field)
    const result = await $.config.set({ key, value }).then(set => set, () => undefined)
    if (result?.deny !== undefined) {
      if (override !== undefined) await orElse($.store.set(field, override), undefined)
      return { field, value, deny: result.deny }
    }
    if (result !== undefined) {
      const applied = typeof result.value === 'number' ? result.value : value
      configApplied[field] = applied
      return { field, value: applied, via: 'config' }
    }
  }
  // Il valore di /config non ha bisogno di un override: si toglie quello che c'è.
  if (value === inConfig[field]) {
    await $.store.delete(field)
    return { field, value, via: 'restored' }
  }
  await $.store.set(field, value)
  return { field, value, via: 'store' }
}

const viaText = (via: Saved['via'], inConfig: Pair, field?: Field) => {
  if (via === 'restored') return 'vale di nuovo /config'
  if (via === 'config') return field === undefined ? 'salvate nelle impostazioni' : 'salvata nelle impostazioni'
  return field === undefined
    ? `salvate dalla mod; /config mostra ancora ${inConfig.threshold}/${inConfig.hardThreshold}%`
    : `salvata dalla mod; /config mostra ancora ${inConfig[field]}%`
}

const isRefused = (outcome: Saved | Refused): outcome is Refused => 'deny' in outcome

// Il testo dell'esito: una frase per valore, una sola se i due sono finiti nello
// stesso posto.
const describeOutcomes = (outcomes: readonly (Saved | Refused)[], asked: number, inConfig: Pair, window: number | undefined) => {
  const saved = FIELDS.flatMap(field => outcomes.filter((one): one is Saved => one.field === field && !isRefused(one)))
  const refused = outcomes.find(isRefused)
  if (saved.length === 0 && refused !== undefined) {
    return `${asked > 1 ? 'Soglie non cambiate' : `Soglia ${LABELS[refused.field]} non cambiata`}: ${refused.deny}`
  }
  const [soft, hard] = saved
  const text =
    soft !== undefined && hard !== undefined && soft.via === hard.via
      ? `Soglie impostate: morbida ${describeThreshold(soft.value, window)}, dura ${describeThreshold(hard.value, window)} (${viaText(soft.via, inConfig)}).`
      : saved
          .map(one =>
            one.field === 'threshold' && one.value === 0
              ? `Monitor di contesto spento, soglia morbida 0% (${viaText(one.via, inConfig, one.field)}).`
              : `Soglia ${LABELS[one.field]} impostata al ${describeThreshold(one.value, window)} (${viaText(one.via, inConfig, one.field)}).`,
          )
          .join(' ')
  return refused === undefined ? text : `${text} Soglia ${LABELS[refused.field]} non cambiata: ${refused.deny}`
}

const alreadyText = (target: Pair, asked: readonly Field[], window: number | undefined) => {
  const [field] = asked
  if (asked.length > 1 || field === undefined) return `Le soglie sono già al ${target.threshold}/${target.hardThreshold}%.`
  if (field === 'threshold' && target.threshold === 0) return 'Il monitor è già spento (soglia morbida 0%).'
  return `La soglia ${LABELS[field]} è già al ${describeThreshold(target[field], window)}.`
}

// Applica le soglie chieste. Prima gli override in $.store, che non ricaricano
// nulla; poi /config, nell'ordine che tiene valida la coppia intermedia
// (alzando la morbida, prima la dura). Con due scritture in /config la seconda
// aspetta in $.state: la prima può far ricaricare il modulo prima che questo
// hook arrivi alla seconda, e allora la completa session.start nel modulo nuovo.
// L'esito porta le soglie in vigore dopo l'azione.
const applyThresholds = async ($: EngineInterface, request: Partial<Pair>, configured: Pair): Promise<ThresholdNotice> => {
  const [settings, usage, rows] = await Promise.all([readSettings($, configured), readUsage($), orElse($.config.list(), [])])
  const { inForce, inConfig, overrides } = settings
  const window = usage?.context.window
  const asked = FIELDS.filter(field => request[field] !== undefined)
  const target: Pair = { ...inForce, ...request }
  const changed = asked.filter(field => target[field] !== inForce[field])
  if (changed.length === 0) return { text: alreadyText(target, asked, window), isError: false, ...inForce }
  const error = checkPair(target, asked)
  if (error !== undefined) return { text: error, isError: true, ...inForce }

  const order: readonly Field[] = target.threshold > inForce.threshold ? ['hardThreshold', 'threshold'] : FIELDS
  const writes: ThresholdWrite[] = order
    .filter(field => changed.includes(field))
    .map(field => ({ field, value: target[field], key: findRow(rows, $.plugin.name, field)?.key, override: overrides[field] }))
  const outcomes: (Saved | Refused)[] = []
  for (const write of writes.filter(one => one.key === undefined)) outcomes.push(await saveField($, write, inConfig))
  const [first, second] = writes.filter(one => one.key !== undefined)
  if (first !== undefined) {
    if (second !== undefined) await $.state.set(PENDING_WRITE, second)
    const done = await saveField($, first, inConfig)
    outcomes.push(done)
    // La seconda la riprende questo modulo, se quello ricaricato dopo la prima non
    // l'ha già presa; dopo un rifiuto si toglie e basta.
    const isMine = second !== undefined && (await claimPendingWrite($)) !== undefined
    if (second !== undefined && !isRefused(done)) {
      if (isMine) outcomes.push(await saveField($, second, inConfig))
      else {
        configApplied[second.field] = second.value
        outcomes.push({ field: second.field, value: second.value, via: 'config' })
      }
    }
  }
  const after = (await readSettings($, configured)).inForce
  return { text: describeOutcomes(outcomes, changed.length, inConfig, window), isError: outcomes.some(isRefused), ...after }
}

// La seconda scrittura di una coppia rimasta in $.state: la completa il modulo
// ricaricato dopo la prima, se quello che l'ha lasciata non ci è arrivato.
const finishPendingWrite = async ($: EngineInterface, configured: Pair) => {
  const write = await claimPendingWrite($)
  if (write === undefined) return
  const inConfig = fromConfig(configured)
  const [done, usage] = await Promise.all([saveField($, write, inConfig), readUsage($)])
  const outcome: ThresholdNotice = {
    text: describeOutcomes([done], 1, inConfig, usage?.context.window),
    isError: isRefused(done),
    ...(await readSettings($, configured)).inForce,
  }
  log($, `scrittura in sospeso completata dopo la ricarica: ${outcome.text}`)
  await orElse(update($, notice, () => outcome), outcome)
  $.ui.toast(outcome.text)
}

// «Ripristina /config»: toglie gli override e tornano a valere le soglie di /config.
const resetOverrides = async ($: EngineInterface, configured: Pair): Promise<ThresholdNotice> => {
  const usage = await readUsage($)
  await Promise.all(FIELDS.map(field => $.store.delete(field)))
  const inConfig = fromConfig(configured)
  const window = usage?.context.window
  const text = `Override della mod tolti: vale /config, morbida ${describeThreshold(inConfig.threshold, window)}, dura ${describeThreshold(inConfig.hardThreshold, window)}.`
  return { text, isError: false, ...inConfig }
}

// Un pulsante del pannello: l'esito va nel pannello e in un toast. Un errore
// porta le soglie rimaste in vigore.
const reportFromPane = async ($: EngineInterface, configured: Pair, run: () => Promise<ThresholdNotice>) => {
  const outcome = await run().catch(
    async (error: unknown): Promise<ThresholdNotice> => ({
      text: `Soglie non cambiate: ${errorText(error)}`,
      isError: true,
      ...(await readSettings($, configured)).inForce,
    }),
  )
  await orElse(update($, notice, () => outcome), outcome)
  $.ui.toast(outcome.text)
}

const only = (field: Field, value: number): Partial<Pair> => (field === 'threshold' ? { threshold: value } : { hardThreshold: value })

// "Soglia dura: 60% · 600k token"; se /config o l'override la tengono sotto
// morbida + 10, quella in vigore e quella impostata.
const describeHard = (pair: Pair, limits: Limits, window: number | undefined) =>
  `${describeThreshold(limits.hard, window)}${limits.hard === pair.hardThreshold ? '' : ` (impostata al ${pair.hardThreshold}%, fuori dai limiti)`}`

const describeOverrides = (settings: Settings, window: number | undefined) => {
  const fields = FIELDS.filter(field => settings.overrides[field] !== undefined)
  const [field] = fields
  if (field === undefined) return undefined
  if (fields.length > 1) return `Salvate dalla mod; in /config restano ${settings.inConfig.threshold}/${settings.inConfig.hardThreshold}%`
  return `${field === 'threshold' ? 'Morbida' : 'Dura'} salvata dalla mod; in /config resta ${describeThreshold(settings.inConfig[field], window)}`
}

export const register: Register = (on, options) => {
  // Le soglie di /config; quelle in vigore le dà readSettings a ogni controllo.
  const configured: Pair = {
    threshold: Number(options.threshold ?? DEFAULTS.threshold),
    hardThreshold: Number(options.hardThreshold ?? DEFAULTS.hardThreshold),
  }
  const maxClearsPerHour = Number(options.maxClearsPerHour ?? 3)

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    // Il pannello di /soglia, se è aperto, segue l'uso del contesto.
    if (e.changed.includes('context')) $.ui.invalidate('ui.render')
    const percent = e.context.percent
    if (percent === undefined) return result
    const limits = await effectiveLimits($, configured)
    const zone = zoneOf(percent, limits)
    if (zone === 0) return result
    const session = await $.session.id()
    if (zone <= (await readSignaled($, session))) return result
    if (pendingNote?.session === session && pendingNote.zone >= zone) return result
    pendingNote = { session, zone, text: await buildNote($, zone, percent, limits) }
    log($, `contesto al ${percent}% (${ZONE_NAMES[zone]}, soglie ${levels(limits, true)}): la nota parte con il prossimo prompt`)
    return result
  })

  on('classic.PostToolUse', async ($, e, next) => {
    const result = await next(e)
    if (e.agent_id !== undefined) return result
    const now = await $.clock.now()
    if (now - lastCheckAt < CHECK_EVERY_MS) return result
    lastCheckAt = now
    const limits = await effectiveLimits($, configured)
    if (limits.soft <= 0) return result
    const { percent } = (await $.session.usage()).context
    if (percent === undefined) return result
    const zone = zoneOf(percent, limits)
    if (zone === 0) return result
    const session = await $.session.id()
    if (!(await markSignaled($, session, zone))) return result
    if (pendingNote?.session === session && pendingNote.zone <= zone) pendingNote = undefined
    log($, `contesto al ${percent}% (${ZONE_NAMES[zone]}) durante il turno: segnalato a Claude`)
    return { ...result, additionalContext: [...(result.additionalContext ?? []), await buildNote($, zone, percent, limits)] }
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    if (pendingNote === undefined) return next(e)
    const note = pendingNote
    pendingNote = undefined
    const session = await $.session.id()
    if (note.session !== session || !(await markSignaled($, session, note.zone))) return next(e)
    log($, `${ZONE_NAMES[note.zone]} segnalata a Claude insieme al prompt`)
    return next({ ...e, context: [...(e.context ?? []), note.text] })
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || e.isAborted || isClearRequested) return result
    const handoff = await readPending($)
    if (handoff?.status !== 'validated') return result

    const now = await $.clock.now()
    const clears = ((await $.store.get(CLEARS_KEY)) as ClearRecord[] | undefined) ?? []
    if (clears.some(clear => clear.handoff === handoff.id)) {
      log($, `l'handoff ${handoff.id} ha già avuto il suo clear: nessun nuovo clear`)
      return result
    }
    if (clears.filter(clear => now - clear.at < HOUR_MS).length >= maxClearsPerHour) {
      log($, `limite di ${maxClearsPerHour} clear in un'ora raggiunto: l'handoff ${handoff.id} resta in attesa`)
      return result
    }
    const busy = (await orElse($.agent.list(), [])).filter(agent => BUSY.includes(agent.status))
    if (busy.length > 0) {
      log($, `handoff ${handoff.id} validato, ma ${busy.length} subagent ancora attivi: clear rimandato al prossimo fine turno`)
      return result
    }

    await $.store.set(CLEARS_KEY, [...clears, { at: now, handoff: handoff.id }].slice(-CLEARS_KEPT))
    isClearRequested = true
    log($, `handoff ${handoff.id} validato: eseguo /clear`)
    runClear($, true)
    return result
  })

  on('session.end', ($, e, next) => {
    if (e.reason === 'clear' && isClearRequested) {
      isClearRequested = false
      pendingNote = undefined
      log($, 'clear eseguito: invio il prompt di ripresa')
      $.prompt.submit({ text: RESUME }).then(
        submitted => {
          if (submitted.drop !== undefined) log($, `prompt di ripresa scartato: ${submitted.drop}`)
        },
        error => log($, `prompt di ripresa rifiutato: ${errorText(error)}`),
      )
    }
    return next(e)
  })

  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    if (e.source !== 'clear' && e.source !== 'compact') return result
    if (e.source === 'compact') {
      await orElse(resetSignaled($), undefined)
      log($, 'compact: le zone tornano da segnalare in questa sessione')
    }
    const handoff = await readPending($)
    if (handoff?.status !== 'validated') return result
    const archived = await archive($, handoff)
    log($, `handoff ${handoff.id} allegato alla sessione (${e.source}) e archiviato in ${archived}`)
    return { ...result, additionalContext: [...(result.additionalContext ?? []), attached(handoff, archived)] }
  }).catch(($, e, next) => next(e))

  // /soglia e il tool context_usage: registrati a ogni caricamento del modulo,
  // anche dopo la ricarica che segue un cambio di soglia; poi la scrittura in
  // sospeso, se la ricarica è arrivata tra le due di una coppia.
  on('session.start', async ($, e, next) => {
    const [, tool] = await Promise.all([
      $.command.register({
        name: 'soglia',
        description: 'Imposta le soglie di contesto di auto-clear-context (morbida e dura)',
        argumentHint: '[N] [M] | morbida N | dura N | spento',
        immediate: true,
      }),
      orElse($.tool.register({ name: CONTEXT_TOOL_NAME, description: CONTEXT_TOOL_DESCRIPTION, isDeferred: false }), undefined),
    ])
    if (tool === undefined) log($, 'tool context_usage non registrato')
    else if (tool.tool !== CONTEXT_TOOL) log($, `tool registrato come ${tool.tool}: l'hook risponde solo a ${CONTEXT_TOOL}`)
    await orElse(finishPendingWrite($, configured), undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  // Il tool context_usage: una riga, senza argomenti; non chiama next, quindi
  // non tocca il motore né altri tool.
  on('tool.call', { tool: CONTEXT_TOOL }, async $ => {
    const [usage, limits] = await Promise.all([readUsage($), effectiveLimits($, configured)])
    return { result: usageLine(usage, limits) }
  }).catch(() => ({ result: 'contesto non disponibile: la lettura della mod non è riuscita' }))

  on('command.run', { command: 'soglia' }, async ($, e) => {
    const text = e.args.trim()
    if (text === '') {
      await orElse(update($, notice, () => null), null)
      await orElse(update($, paneTarget, () => 'threshold'), 'threshold')
      const opened = await $.ui
        .open({ id: PANE, title: 'Soglie di contesto', focus: true, closeOnEscape: true, rows: PANE_ROWS })
        .catch((error: unknown) => ({ isPlaced: false as const, reason: errorText(error) }))
      if (opened.isPlaced) return {}
      const [settings, usage] = await Promise.all([readSettings($, configured), readUsage($)])
      const limits = limitsOf(settings.inForce)
      const window = usage?.context.window
      const current = `morbida ${describeThreshold(limits.soft, window)}, dura ${describeThreshold(limits.hard, window)}, margine di sicurezza ${limits.margin}%`
      return { text: `Il pannello di /soglia non si apre qui (${opened.reason}). Soglie attuali: ${current}; si cambiano con /soglia N M.` }
    }
    const request = parseRequest(text)
    if (request === undefined) return { text: `"${text}" non è una soglia valida: ${USAGE}` }
    const outcome = await applyThresholds($, request, configured)
    await orElse(update($, notice, () => outcome), outcome)
    return { text: outcome.text }
  }).catch(() => ({ text: '/soglia non è riuscito: le soglie si cambiano anche da /config.' }))

  // Il pannello: soglie in vigore, margine e contesto con la zona; il valore in
  // modifica (t lo cambia), i suoi preset con i token, −5/+5 e, con un override,
  // «Ripristina /config». Le opzioni che romperebbero morbida + 10 ≤ dura non
  // compaiono. Tasti nel terminale (le cifre i preset, t il valore, m e p i
  // passi, r il ripristino, Esc chiude), clic nell'app.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const [usage, settings, last, editing] = await Promise.all([
      readUsage($),
      readSettings($, configured),
      orElse(read($, notice), null),
      orElse(read($, paneTarget), 'threshold' as const),
    ])
    const { inForce, inConfig } = settings
    const limits = limitsOf(inForce)
    const window = usage?.context.window
    const other: Field = editing === 'threshold' ? 'hardThreshold' : 'threshold'
    const current = inForce[editing]
    const { min, max } = boundsOf(editing, inForce)
    const fits = (percent: number) => percent >= min && percent <= max
    const presets = PRESETS[editing].filter(percent => percent === current || fits(percent))
    const down = stepThreshold(current, -STEP)
    const up = stepThreshold(current, STEP)
    const overrides = describeOverrides(settings, window)
    const choose = (percent: number) => () => {
      void reportFromPane($, configured, () => applyThresholds($, only(editing, percent), configured))
    }
    const toggle = () => {
      void update($, paneTarget, field => (field === 'threshold' ? 'hardThreshold' : 'threshold'))
    }
    const reset = () => {
      void reportFromPane($, configured, () => resetOverrides($, configured))
    }
    // Un esito vale finché le soglie in vigore sono quelle che ha prodotto: dopo
    // un cambio da fuori (un'altra sessione, /config) non si mostra più.
    const shown = last !== null && last.threshold === inForce.threshold && last.hardThreshold === inForce.hardThreshold ? last : null

    return (
      <Box flexDirection="column">
        <Text bold={editing === 'threshold'}>Soglia morbida: {describeThreshold(inForce.threshold, window)}</Text>
        <Text bold={editing === 'hardThreshold'}>Soglia dura: {describeHard(inForce, limits, window)}</Text>
        <Text dimColor>{`Margine di sicurezza: ${describeThreshold(limits.margin, window)} (dura + ${MARGIN_GAP})`}</Text>
        {overrides !== undefined && <Text color="warning">{overrides}</Text>}
        <Text dimColor>{describeUsage(usage, limits)}</Text>
        <Box marginTop={1}>
          <Button key="target" hotkey="t" plain onPress={toggle}>
            In modifica: {LABELS[editing]}
            <Text dimColor> · passa alla {LABELS[other]}</Text>
          </Button>
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {presets.map(percent => (
            <Button
              key={`preset-${percent}`}
              hotkey={String(percent / 10)}
              plain
              variant={percent === current ? 'primary' : 'secondary'}
              onPress={choose(percent)}
            >
              {percent === 0 ? 'Spento' : describeThreshold(percent, window)}
              {percent === current && <Text dimColor> ← attuale</Text>}
            </Button>
          ))}
        </Box>
        <Box marginTop={1} columnGap={3}>
          {down !== current && fits(down) && (
            <Button key="down" hotkey="m" plain onPress={choose(down)}>
              −5 → {down === 0 ? 'spento' : `${down}%`}
            </Button>
          )}
          {up !== current && fits(up) && (
            <Button key="up" hotkey="p" plain onPress={choose(up)}>
              +5 → {up}%
            </Button>
          )}
        </Box>
        {overrides !== undefined && (
          <Button key="reset" hotkey="r" plain onPress={reset}>
            {`Ripristina /config (${inConfig.threshold}/${inConfig.hardThreshold}%)`}
          </Button>
        )}
        {shown !== null && <Text color={shown.isError ? 'error' : 'success'}>{shown.text}</Text>}
        <Text dimColor>Valori liberi: /soglia N M (morbida e dura){e.surface === 'terminal' ? ' · Esc chiude' : ''}</Text>
      </Box>
    )
  })
}
