---
name: handoff
description: Salva lo stato del lavoro in .claude/handoff/pending/<id della sessione>.md, lo fa validare da un subagent fresco e lo segna come validato, così la mod auto-clear-context esegue /clear e fa ripartire il lavoro da solo. Da usare quando la mod segnala una zona di contesto (morbida, dura, margine di sicurezza) o quando l'utente chiede un handoff.
---

# Handoff

1. **Porta il lavoro a un punto stabile**, secondo la zona che la mod ha segnalato:
   - **morbida** (o handoff chiesto dall'utente): il prossimo punto naturale, cioè un sotto-task finito e verificato (test verdi o build ok), il risultato di un subagent integrato, il momento prima di aprire un file nuovo o iniziare un sotto-task nuovo, la fine di una risposta quando il passo dopo è un argomento nuovo. Mai a metà di un edit, con modifiche su più file incoerenti, a metà di un debug o con una domanda all'utente in sospeso.
   - **dura**: completa l'azione atomica in corso e non iniziarne altre.
   - **margine di sicurezza**: subito, anche con lavoro a metà.

   In ogni zona: nessun lavoro in background ancora attivo (subagent, comandi in background, monitor): aspettalo o fermalo. Se in zona dura o nel margine resta lavoro a metà (debug aperto, test rossi, modifica incompleta), l'handoff ha la sezione "Lavoro interrotto".
2. **Raccogli i fatti, non andare a memoria**: `git status --short`, `git rev-parse --abbrev-ref HEAD`, `git log --oneline -5` e l'esito dei comandi di test/build che citerai. Ciò che non hai verificato in questa sessione va in "Ipotesi da verificare", non in "Stato verificato".
3. **Scrivi `.claude/handoff/pending/${CLAUDE_SESSION_ID}.md`** nella root del progetto, con il formato qui sotto (punta a 1.000-2.000 token, massimo 9.000 caratteri), `status: draft` e `session: ${CLAUDE_SESSION_ID}`.
   - È il file di questa sessione. Nella stessa cartella possono lavorare altre sessioni, ognuna con il suo, e la mod esegue /clear solo nella sessione che l'ha scritto e allega l'handoff alla sessione pulita che la segue.
   - Non scrivere in `.claude/handoff/pending.md` (il file condiviso delle versioni precedenti) né nel file di un'altra sessione.
   - Solo se il percorso qui sopra non contiene un id di sessione, usa quello dell'ultima nota di zona della mod e metti in `session` l'id che compare nel nome di quel file.
   - Se il progetto è un repo git, `.claude/handoff/` deve stare in `.git/info/exclude`; aggiungilo se manca. Niente commit né push di questi file.
4. **Fallo validare** dall'agent `auto-clear-context:handoff-validator`, in foreground, passandogli **solo** il percorso assoluto del file. Confronta la sua ricostruzione con lo stato reale, correggi le lacune e rilancia. Al massimo 2 giri.
5. **Segna l'handoff come validato** nel frontmatter: `status: validated`, `validated_at` (ISO 8601) e `rounds`; `session` resta com'è.
6. **Chiudi il turno con una sola riga** che nomina il file dell'handoff, senza altre azioni. A fine turno la mod esegue /clear, allega l'handoff alla sessione pulita e fa ripartire il lavoro; se il /clear non arriva, la riga dice da quale file riprendere a mano.

## Formato

Ogni sezione è obbligatoria; se non ha contenuto scrivi "nessuno", tranne "Lavoro interrotto" che compare solo quando serve.

```markdown
---
status: draft
session: ${CLAUDE_SESSION_ID}
created_at: <ISO 8601>
validated_at:
rounds: 0
branch: <branch git, o "nessun repo">
head: <sha corto di HEAD>
---
# Handoff: <titolo del lavoro>

## Obiettivo
<che cosa si costruisce e perché, 2-4 righe>
- Fatto quando: <criterio verificabile di completamento>

## Vincoli dell'utente
- "<vincolo citato parola per parola>"

## Stato verificato
- <cosa funziona adesso>: `<comando>` → <esito in una riga>

## Modifiche
- `<percorso>[:riga | simbolo]`: <cosa è cambiato e perché, una riga>
- Non committato: <file da `git status --short`, o "nessuno">

## Decisioni
- <decisione>: <motivazione>; scartato <alternativa> perché <motivo>

## Strade escluse
- <tentativo>: <perché non funziona, così non si riprova>

## Ipotesi da verificare
- <assunzione non ancora provata e come verificarla>

## Task
- [fatto | in corso | da fare | bloccato] <task>: <descrizione>
  - [stato] <sotto-task>: <descrizione>

## Metodo di coordinamento
- Task list: <dove sta e come si aggiorna>
- Skill da richiamare: `<plugin:skill>`: <a che punto del flusso; per esempio executing-plans al task 3 del piano>
- Plugin, server MCP e CLI necessari: <nome>: <a cosa serve; se è spento o non connesso, dillo>
- Subagent e ruoli: `<tipo di agent>`: <chi fa cosa>
- Build e test: <comandi esatti>
- Convenzioni: <stile, naming>

## Riferimenti
- `<percorso o URL>`: <cosa contiene: spec, piano, log; non copiarne il contenuto>

## Lavoro interrotto
<solo se l'handoff parte in zona dura o nel margine di sicurezza con lavoro a metà>
- In corso: <cosa si stava facendo e a che punto è rimasto>
- Test che falliscono: `<comando>`: <errore, le righe che contano>
- Primo passo per riprendere: <azione concreta, con file e comando>

## Verifica alla ripresa
- `<comando>`: <esito atteso> (da lanciare prima di toccare il codice)

## Prossimo passo immediato
<una sola azione concreta: file, simbolo, comando>
- Poi: <passi successivi in ordine>
```

## Regole

- **Autosufficiente**: si legge a freddo. Niente "come detto sopra", "quel file", "la soluzione di prima".
- **Solo fatti verificati** in "Stato verificato"; il resto va in "Ipotesi da verificare". Niente "fatto" senza prova.
- **Riferimenti, non contenuti**: percorsi con riga o simbolo; niente output grezzo di tool, stack trace o log interi (al massimo le 2-3 righe che contano).
- Niente segreti (token, password, chiavi).
- Percorsi relativi alla root del progetto.
- Skill, plugin e agent con il **nome esatto** con cui si invocano (`plugin:skill`), solo quelli in uso o necessari per i prossimi passi; "nessuno" se non ce ne sono.
- I vincoli dati dall'utente (per esempio "niente commit") vanno in "Vincoli dell'utente", parola per parola.
- "Lavoro interrotto", quando c'è, ha sempre i suoi tre elementi; senza test che falliscono lo dice ("nessuno"). Le ipotesi escluse vanno in "Strade escluse".
