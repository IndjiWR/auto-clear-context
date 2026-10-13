// Il contratto di $.state della mod: i valori che il pannello di /soglia e il
// monitor leggono, tenuti dal motore anche quando il modulo si ricarica.

/** Un campo di userConfig delle soglie: la morbida (`threshold`) o la dura (`hardThreshold`). */
export type ThresholdField = 'threshold' | 'hardThreshold'

/**
 * L'esito dell'ultima modifica delle soglie, mostrato nel pannello finché le
 * soglie in vigore sono ancora `threshold` (morbida) e `hardThreshold` (dura):
 * quelle prodotte dall'azione, o rimaste in vigore se l'azione è fallita.
 */
export type ThresholdNotice = { text: string; isError: boolean; threshold: number; hardThreshold: number }

/** La zona già segnalata a Claude: 0 nessuna, 1 morbida, 2 dura, 3 margine di sicurezza. */
export type ThresholdZone = 0 | 1 | 2 | 3

/**
 * Una scrittura in /config ancora da fare: la seconda di una coppia, che il
 * modulo ricaricato dopo la prima completa se chi l'ha lasciata non ci arriva.
 * `key` è la riga di /config; `override` l'override in $.store da rimettere se
 * config.set la rifiuta.
 */
export type ThresholdWrite = { field: ThresholdField; value: number; key?: string; override?: number }

declare module 'claude-code' {
  interface PluginState {
    'auto-clear-context': {
      thresholdNotice: ThresholdNotice | null
      /** Per session id: la zona più alta già segnalata a Claude in quella sessione. */
      signaledZone: StateFamily<ThresholdZone>
      /** Il valore che il pannello di /soglia sta modificando. */
      paneTarget: ThresholdField
      pendingWrite: ThresholdWrite | null
    }
  }

  interface McpToolInputs {
    /** Il tool context_usage della mod: nessun argomento. */
    'mcp__auto-clear-context__context_usage': Record<never, never>
  }
}
