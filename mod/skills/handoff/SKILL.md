---
name: handoff
description: Salva lo stato del lavoro in .claude/handoff/pending.md, lo fa validare da un subagent fresco e lo segna come validato, così la mod auto-clear-context esegue /clear e fa ripartire il lavoro da solo. Da usare quando la mod segnala una zona di contesto (morbida, dura, margine di sicurezza) o quando l'utente chiede un handoff.
---

# Handoff

1. **Porta il lavoro a un punto stabile**, secondo la zona che la mod ha segnalato:
   - **morbida** (o handoff chiesto dall'utente): il prossimo punto naturale, cioè un sotto-task finito e verificato (test verdi o build ok), il risultato di un subagent integrato, il momento prima di aprire un file nuovo o iniziare un sotto-task nuovo, la fine di una risposta quando il passo dopo è un argomento nuovo. Mai a metà di un edit, con modifiche su più file incoerenti, a metà di un debug o con una domanda all'utente in sospeso.
   - **dura**: completa l'azione atomica in corso e non iniziarne altre.
   - **margine di sicurezza**: subito, anche con lavoro a metà.

   In ogni zona: nessun lavoro in background ancora attivo (subagent, comandi in background, monitor): aspettalo o fermalo. Se in zona dura o nel margine resta lavoro a metà (debug aperto, test rossi, modifica incompleta), l'handoff ha la sezione "Lavoro interrotto".
2. **Scrivi `.claude/handoff/pending.md`** nella root del progetto, sotto i 9.000 caratteri, con il formato qui sotto e `status: draft`. Se il progetto è un repo git, `.claude/handoff/` deve stare in `.git/info/exclude`; aggiungilo se manca. Niente commit né push di questi file.
3. **Fallo validare** dall'agent `auto-clear-context:handoff-validator`, in foreground, passandogli **solo** il percorso assoluto del file. Confronta la sua ricostruzione con lo stato reale, correggi le lacune e rilancia. Al massimo 2 giri.
4. **Segna l'handoff come validato** nel frontmatter: `status: validated`, `validated_at` (ISO 8601) e `rounds`.
5. **Chiudi il turno con una sola riga**, senza altre azioni. A fine turno la mod esegue /clear, allega l'handoff alla sessione pulita e fa ripartire il lavoro.

## Formato

```markdown
---
status: draft
created_at: <ISO 8601>
validated_at:
rounds: 0
---
# Handoff: <titolo del lavoro>

## Obiettivo
<che cosa si costruisce e perché, 2-4 righe>

## Task e sotto-task
- [fatto | in corso | da fare | bloccato] <task>: <descrizione>
  - [stato] <sotto-task>: <descrizione>

## Decisioni
- <decisione>: <motivazione>

## File attivi
- `<percorso>`: <stato: cosa è cambiato, cosa manca>

## Metodo di coordinamento
- Task list: <dove sta e come si aggiorna>
- Subagent e ruoli: <chi fa cosa>
- Ordine di lavoro: <sequenza concordata>
- Build e test: <comandi esatti>
- Convenzioni concordate: <stile, naming, vincoli dell'utente>

## Lavoro interrotto
<solo se l'handoff parte in zona dura o nel margine di sicurezza con lavoro a metà; altrimenti la sezione non c'è>
- In corso: <cosa si stava facendo e a che punto è rimasto>
- Ipotesi escluse: <cosa è già stato provato e scartato, e perché>
- Test che falliscono: `<comando>`: <errore, le righe che contano>
- Primo passo per riprendere: <azione concreta, con file e comando>

## Prossimo passo immediato
<una sola azione concreta, con file e comando>
```

## Regole

- Solo fatti verificati. Niente segreti (token, password, chiavi).
- Percorsi relativi alla root del progetto.
- I vincoli dati dall'utente (per esempio "niente commit") vanno in "Convenzioni concordate", parola per parola.
- "Lavoro interrotto", quando c'è, ha sempre i quattro elementi; senza test che falliscono lo dice ("nessuno").
