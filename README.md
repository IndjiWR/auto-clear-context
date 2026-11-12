# auto-clear-context

A **Claude Code** mod that keeps long sessions going on its own: near the context thresholds Claude saves its state in a validated handoff, the mod runs `/clear` and the work resumes by itself in the clean session.

*Mod per Claude Code: vicino alle soglie di contesto Claude salva lo stato in un handoff validato, la mod esegue `/clear` e il lavoro riparte da solo nella sessione pulita.*

**[English](#english)** · **[Italiano](#italiano)**

---

## English

As a Claude Code session grows, the context window fills up and the work has to be cleared and rebuilt by hand. auto-clear-context automates that loop. When usage crosses a threshold, the mod tells Claude to write a *handoff* of the work in progress; a fresh read-only subagent rebuilds the task from that file alone and lists the gaps; once the handoff is marked validated, the mod runs `/clear` at the end of the turn, attaches the handoff to the new session and resumes from its "next step". No typing needed.

The mod nudges, it does not force: it adds a note to Claude's context once per zone, and Claude decides when to hand off by following the skill's rules. If no handoff is made, Claude Code's own auto-compact, when enabled, remains the fallback. The mod's messages, the `/soglia` panel and the skill are written in Italian (*soglia* = threshold, *morbida* = soft, *dura* = hard).

### What it contains

| Part | Role |
| --- | --- |
| Hooks module (`mod/hooks/register.tsx`) | Measures context usage, tells Claude when it enters a zone, runs `/clear` and the resume; registers the `/soglia` command and the `context_usage` tool |
| Skill `auto-clear-context:handoff` (`mod/skills/handoff/`) | Writes the session's own `.claude/handoff/pending/<session id>.md`, has it checked by the validator, marks it `status: validated` |
| Agent `auto-clear-context:handoff-validator` (`mod/agents/`) | Read-only subagent (Read, Glob, Grep): rebuilds the work from the handoff alone and checks it against a 12-point checklist (self-contained, git state, real paths, resume checks, verified facts vs assumptions, skills and tools by exact name) |

### How it works

| Zone | Default | With a 1M-token window | What Claude is told to do |
| --- | --- | --- | --- |
| Normal | below 40% | up to 400k | keep working |
| Soft | from 40% | 400k | hand off at the next natural point: a finished, verified sub-task, or before opening a new file or feature |
| Hard | from 60% | 600k | finish the atomic action in progress and hand off at the first safe point, recording unfinished work under "Lavoro interrotto" (interrupted work) |
| Safety margin | from 75% (hard + 15) | 750k | hand off immediately, even with work half done |

Each zone is signalled at most once per session (only the highest one if usage jumps past several), either with the next prompt or mid-turn, checked after tool calls at most every 30 s. After a compact the zones re-arm, and if auto-compact fires before the clear, the session's validated handoff is attached to the compacted session instead. A typical cycle in the transcript (values illustrative):

```text
auto-clear-context: contesto al 41% (zona morbida, soglie 40/60/75%): la nota parte con il prossimo prompt
auto-clear-context: zona morbida segnalata a Claude insieme al prompt
auto-clear-context: handoff 9b1c4e2a1f3c della sessione 3f2a8c1d validato: eseguo /clear
auto-clear-context: clear eseguito: invio il prompt di ripresa
auto-clear-context: handoff 9b1c4e2a1f3c della sessione 3f2a8c1d allegato alla sessione (clear) e archiviato in .claude/handoff/archive/2026-10-12T10-15-00-000Z-9b1c4e2a1f3c.md
```

In order: the soft zone is reached at 41% and the note goes out with the next prompt; the handoff is validated and the mod runs `/clear`; the resume prompt is sent; the handoff is attached to the new session and archived.

In the project the mod uses `.claude/handoff/`: `pending/` (one handoff per session), `archive/` and `events.log`.

### Several sessions in one folder

Each session writes its handoff to its own file, `.claude/handoff/pending/<session id>.md`, with `session: <session id>` in the frontmatter. The skill gets the id from `${CLAUDE_SESSION_ID}`, and the zone note names the same path. At the end of a turn the mod looks only at the current session's handoff, so a session never clears because another one validated its own. After a `/clear` it attaches only the handoff of the session that the clear closed. Two sessions can hand off at the same time without overwriting each other.

A validated handoff stays in its file if its session is closed before the clear (for example while the hourly cap holds the clear back). No other session takes it over. While that session is still open, a manual `/clear` there attaches the handoff (without the resume prompt); otherwise resume it by hand by asking Claude to read the file. A draft left behind can only be resumed by hand.

Handoffs written by earlier versions in the shared `.claude/handoff/pending.md` are used only when their frontmatter carries `session:` with the id of the session that reads them. Without that field the file belongs to no session: none clears or resumes from it, it stays where it is, and the log says so once. Resume it by hand or delete it.

Restart open sessions after updating. A session still running the previous module reads only the shared `pending.md`, so a handoff written to the new path would not clear there.

### Install

Installation runs **from a terminal**. Installed with the `user` scope, the mod also applies to the Code tab of the desktop app on the same machine (the install command is not available there). Open new sessions after installing.

In a Claude Code terminal session:

```text
/plugin install auto-clear-context --marketplace IndjiWR/auto-clear-context
```

Answer `y` to add the marketplace and pick the `user` scope. Or from a shell:

```bash
claude plugin install auto-clear-context --marketplace IndjiWR/auto-clear-context --scope user
```

From a local clone (`git clone https://github.com/IndjiWR/auto-clear-context.git`), pass its path instead: `claude plugin install auto-clear-context --marketplace <path-to-clone> --scope user`. The plugin is then read from that folder, so don't move or delete it.

Update with `claude plugin update auto-clear-context`.

### Configuration

| Option | Default | Accepted by `/soglia` | Meaning |
| --- | --- | --- | --- |
| `threshold` | 40 | 0, or 1–85 and at least 10 below hard | soft zone (%); `0` turns the monitor off |
| `hardThreshold` | 60 | soft + 10 to 95 | hard zone (%) |
| `maxClearsPerHour` | 3 | — | automatic clears per rolling hour, counted across all sessions; `0` disables them; above 20 means no cap (the mod keeps only the last 20 clears) |

The safety margin is always hard + 15, capped at 95%. Only `/soglia` checks the ranges above: values set in `/config` or at install are taken as given, except that the hard threshold in force is raised to at least soft + 10 and capped at 95.

Ways to set them:

- at install time: `claude plugin install auto-clear-context --marketplace IndjiWR/auto-clear-context --config threshold=45`;
- in `/config`, where the plugin's options are listed;
- with `/soglia`: `/soglia 45` sets the soft threshold, `/soglia 45 65` soft and hard (use it to move both when the soft one would end up less than 10 below the hard one), `/soglia morbida 45` or `/soglia dura 65` one of them, `/soglia 0` (or `off`) turns the monitor off. `/soglia` alone opens a panel with presets and their token counts (terminal keys: digits for presets, `t` to switch between soft and hard, `m`/`p` for −5/+5, `Esc` to close).

Where `/config` has no rows for the plugin (headless sessions, the desktop Code tab), `/soglia` saves the values in the mod's own store. They apply at once in every session and take precedence over `/config` from then on; set the `/config` value again with `/soglia` to drop the override.

![The /soglia panel in a terminal session: soft and hard thresholds with their token counts, presets and −5/+5 steps](docs/soglia-panel.png)

*The `/soglia` panel in a terminal session, here with soft 30% and hard 50% on a 1M-token window.*

Claude can read the current usage and zone with the mod's `context_usage` tool, which answers with one line such as `47% · zona morbida (40/60%)`. To hand off by hand, ask Claude to use the `auto-clear-context:handoff` skill.

### Safety limits

- **Only a handoff marked validated clears.** The mod runs `/clear` only when the frontmatter of the session's handoff says `status: validated`, which the skill sets after up to 2 rounds with the read-only validator. A draft never triggers a clear. The mod trusts that flag: it reads only the frontmatter, so a file marked validated by hand clears too.
- **Only for the session that wrote it.** The clear runs only in the session that wrote the handoff, and only the fresh session that follows that clear gets the handoff attached. A validated file in a session's slot whose frontmatter carries another session's id is skipped and logged.
- **One clear per handoff**, and at most `maxClearsPerHour` (default 3) per rolling hour; past that the handoff waits. The count is kept in the mod's store, so it is shared by all sessions on the machine.
- **Never with work in flight.** No clear while a subagent is pending, running or waiting, after an interrupted turn, or at the end of a subagent's turn. In every zone the skill makes Claude wait for or stop background work first. In the soft and hard zones the skill and the zone notes also rule out handing off mid-edit, mid-debug or with a question to the user pending; whatever is left unfinished in the hard zone or the safety margin goes into the handoff's interrupted-work section.
- **Bounded retry.** If `/clear` fails the mod retries once after 300 ms, then gives up and logs why. That handoff then counts as used: change it and validate it again to get a new clear.
- **Everything is visible.** Every step shows up in the transcript (`auto-clear-context: …` lines) and in `.claude/handoff/events.log` (last 300 events).
- **Kept out of git.** When the project root has a `.git` directory, the mod adds `.claude/handoff/` to `.git/info/exclude`, which is local and never committed. The skill also tells Claude to keep handoffs under 9,000 characters and free of secrets; the mod does not check either.

### Known limits

- The "Ripristina /config" (restore `/config`) button of the `/soglia` panel does not work yet in real sessions, although the test kit's version of the flow passes: set the value with `/soglia N`.
- The mod cannot see background commands (Bash, monitors); the skill makes Claude wait for them or stop them before the handoff.
- The git exclude is skipped in worktrees and submodules, where `.git` is a file.
- The mods API cannot delete files: after the resume a session's file in `.claude/handoff/pending/` stays behind empty (an empty file means nothing pending). Empty files and drafts left by closed sessions pile up there and can be deleted by hand.
- Claude Code only (terminal and the desktop Code tab); it does not run in claude.ai chats.
- Organization policies can block personal mods: if `/status` shows "Enterprise managed settings", ask your admin.

### Early-access mods API

Mods are in **early access**: the hooks API this module is built on (`register`, `$.session`, `$.command`, `$.ui`, `$.state`, the `claude-code/testing` kit) can change between Claude Code releases, and a new release can break the mod until it is updated. Check the versions below before relying on it.

### Tested Claude Code versions

| Version | Surface | Result |
| --- | --- | --- |
| 2.1.322 | `claude plugin test mod` (macOS) | 37 of 37 tests pass; `claude plugin validate` passes |
| 2.1.296 | `claude plugin test mod` (Windows 11) | 37 of 37 tests pass; `claude plugin validate` passes |
| 2.1.296 | terminal | manual tests in real sessions |
| 2.1.295 | desktop app, Code tab (Windows) | manual tests in real sessions |
| 2.1.212 | any | not supported: no mods API |

The one-line `/plugin install … --marketplace` form needs Claude Code 2.1.275 or later. Check your version with `claude --version` and update with `claude update`.

### How it is built

One TypeScript/TSX hooks module on the mods API:

| Event | Role |
| --- | --- |
| `session.measure`, `classic.PostToolUse` | watch context usage after each turn and during long turns |
| `prompt.submit` | attaches the zone note to the next prompt |
| `turn.complete` | checks the session's own handoff, the caps and running subagents, then runs `/clear` |
| `session.end` | remembers which session the clear closed and submits the resume prompt |
| `classic.SessionStart` | attaches the validated handoff of the session the clear closed (or of the compacted one) and archives it |
| `session.start`, `command.run`, `ui.render`, `tool.call` | register and serve `/soglia`, its panel and `context_usage` |

Zone flags live in `$.state` and are written with `ifVersion`, so the two monitor channels never signal the same zone twice. A two-value threshold change parks its second write in `$.state`, so it survives the module reload that a `/config` write triggers. The tests use the official `claude-code/testing` kit and render the `/soglia` panel on both the terminal and the desktop surface.

### Development

```text
.claude-plugin/marketplace.json   marketplace entry pointing at ./mod
mod/.claude-plugin/plugin.json    manifest and userConfig options
mod/hooks/hooks.json              loads register.tsx
mod/hooks/register.tsx            the hooks module
mod/types/index.d.ts              the $.state contract
mod/skills/handoff/SKILL.md       handoff skill
mod/agents/handoff-validator.md   read-only validator agent
mod/tests/*.test.ts               tests (claude-code/testing)
mod/tsconfig.json                 extends the types the engine writes
```

Run `claude plugin validate .` (marketplace), `claude plugin validate mod` (manifest and module) and `claude plugin test mod` (tests). To try the mod from a clone without installing it, start Claude Code with `claude --plugin-dir mod`; the engine then writes the API types into `mod/.claude-plugin/types/`, which `mod/tsconfig.json` extends.

### Uninstall

```bash
claude plugin uninstall auto-clear-context
```

Any `.claude/handoff/` folders in your projects can then be deleted by hand.

---

## Italiano

Mod per **Claude Code** che gestisce da sola le conversazioni lunghe. Quando il contesto si riempie, Claude salva lo stato del lavoro in un *handoff*, un subagent lo verifica, la mod esegue `/clear` e il lavoro riparte da solo nella sessione pulita, con l'handoff allegato. Non serve scrivere niente.

### Cosa contiene

| Parte | Cosa fa |
| --- | --- |
| Mod (`mod/hooks/register.tsx`) | Misura il contesto, avvisa Claude quando entra in una zona, esegue `/clear` e la ripresa; comando `/soglia`; tool `context_usage` |
| Skill `auto-clear-context:handoff` (`mod/skills/handoff/`) | Scrive il file della sessione, `.claude/handoff/pending/<id della sessione>.md`, lo fa validare e lo segna come validato |
| Agent `auto-clear-context:handoff-validator` (`mod/agents/`) | Subagent in sola lettura: ricostruisce il lavoro dal solo handoff e lo verifica con 12 controlli (autosufficienza, stato git, percorsi reali, verifica alla ripresa, fatti separati dalle ipotesi, skill e strumenti col nome esatto) |

### Come funziona

| Zona | Default | Con una finestra da 1M token | Cosa fa Claude |
| --- | --- | --- | --- |
| Normale | sotto il 40% | fino a 400k | lavora normalmente |
| Morbida | dal 40% | 400k | fa l'handoff al prossimo punto naturale (sotto-task finito e verificato, prima di un file o una feature nuova) |
| Dura | dal 60% | 600k | fa l'handoff al primo punto sicuro, anche con lavoro a metà (lo descrive in "Lavoro interrotto") |
| Margine di sicurezza | dal 75% (dura + 15) | 750k | fa l'handoff subito |

Nelle zone morbida e dura mai a metà di un edit o di un debug; in nessuna zona con lavoro in background attivo.

Dopo l'handoff validato, a fine turno la mod esegue `/clear`, allega l'handoff alla sessione nuova e fa ripartire il turno dal "prossimo passo".

**Più sessioni nella stessa cartella.** Ognuna scrive il suo handoff in `.claude/handoff/pending/<id della sessione>.md`, con `session: <id della sessione>` nel frontmatter. La skill prende l'id da `${CLAUDE_SESSION_ID}` e la nota di zona riporta lo stesso percorso. A fine turno la mod guarda solo l'handoff della sessione, quindi una sessione non fa mai `/clear` per l'handoff validato di un'altra; dopo il `/clear` allega solo l'handoff della sessione che il clear ha chiuso.

Se la sessione si chiude prima del clear (per esempio mentre il limite orario lo trattiene), l'handoff validato resta nel suo file e nessun'altra sessione lo prende. Finché quella sessione è aperta, un `/clear` a mano lì allega l'handoff (senza il prompt di ripresa); altrimenti chiedi a Claude di leggere quel file. Una bozza rimasta lì si riprende solo a mano.

Gli handoff delle versioni precedenti, nel `.claude/handoff/pending.md` condiviso, valgono solo se il frontmatter porta `session:` con l'id della sessione che li legge. Senza quel campo il file non è di nessuna sessione: nessuna fa `/clear` né riprende da lì, il file resta dov'è e il log lo segnala una volta. Riprendilo a mano o cancellalo.

Dopo l'aggiornamento riavvia le sessioni aperte: finché usano la versione vecchia della mod leggono solo il `pending.md` condiviso, e un handoff scritto nel percorso nuovo lì non fa partire il `/clear`.

Sicurezze:
- `/clear` solo nella sessione che ha scritto l'handoff, e l'handoff va solo alla sessione pulita che la segue;
- un solo clear per handoff, al massimo 3 clear all'ora contati su tutte le sessioni (opzione `maxClearsPerHour`);
- nessun clear con subagent ancora attivi;
- ogni passaggio compare nel transcript (righe `auto-clear-context: …`) e in `.claude/handoff/events.log`.

Nel progetto la mod usa la cartella `.claude/handoff/`, con `pending/` (un handoff per sessione), `archive/` ed `events.log`. Se la root del progetto ha una cartella `.git`, la aggiunge da sola a `.git/info/exclude`, così non finisce in un commit.

### Requisiti

- **Solo Claude Code**: terminale e tab Code dell'app desktop. Non funziona nelle chat di claude.ai.
- **Claude Code recente.** Provata su 2.1.295 (tab Code dell'app desktop, Windows) 2.1.296 (terminale) e 2.1.322 (test su macOS); la 2.1.212 non supporta le mods. Controlla con `claude --version` (aggiorna con `claude update`) o con `/status`.
- **Early access.** Le mods sono in early access e l'API può cambiare tra una versione e l'altra.
- **Account aziendali.** Le policy dell'organizzazione possono bloccare le mod personali. Se `/status` mostra "Enterprise managed settings", chiedi all'admin.

### Installazione

L'installazione si fa **dal terminale**. Installata con scope `user`, la mod vale anche per il tab Code dell'app sulla stessa macchina (lì il comando di installazione non è disponibile). Dopo l'installazione apri sessioni nuove.

#### Da GitHub

In una sessione di Claude Code nel terminale:

```text
/plugin install auto-clear-context --marketplace IndjiWR/auto-clear-context
```

Rispondi `y` per aggiungere il marketplace e scegli lo scope `user`. In alternativa, da una shell:

```bash
claude plugin install auto-clear-context --marketplace IndjiWR/auto-clear-context --scope user
```

Per aggiornare a una nuova versione:

```bash
claude plugin update auto-clear-context
```

#### Da un clone locale

```bash
git clone https://github.com/IndjiWR/auto-clear-context.git
```

```bash
claude plugin install auto-clear-context --marketplace <percorso-del-clone> --scope user
```

Il plugin viene letto da quella cartella: non spostarla e non cancellarla.

### Uso

- **Automatico.** Non serve fare niente: le righe `auto-clear-context: …` mostrano i passaggi.
- **`/soglia`** apre un pannello per scegliere le soglie, ognuna con i token corrispondenti. In alternativa:
  - `/soglia 45` imposta la morbida;
  - `/soglia 45 65` imposta morbida e dura;
  - `/soglia 0` spegne il monitor.
- **Handoff a mano.** Chiedi a Claude: "usa la skill auto-clear-context:handoff".
- **Contesto attuale.** Claude può controllarlo con il tool `context_usage` della mod.

![Il pannello /soglia nel terminale: soglie morbida e dura con i token, preset e passi −5/+5](docs/soglia-panel.png)

### Limiti noti

- Il pulsante "Ripristina /config" del pannello `/soglia` non funziona ancora: imposta il valore con `/soglia N`.
- I comandi in background (Bash, monitor) la mod non li vede: la skill fa aspettare o fermare Claude prima dell'handoff.
- Nei worktree e nei submodule, dove `.git` è un file, l'esclusione da git non viene aggiunta.
- L'API delle mod non cancella file: dopo la ripresa il file della sessione in `.claude/handoff/pending/` resta vuoto (vuoto vuol dire nessun handoff in attesa). I file vuoti e le bozze delle sessioni chiuse si accumulano lì e si possono cancellare a mano.

### Sviluppo

```bash
claude plugin validate .
```

```bash
claude plugin test mod
```

Il primo comando controlla il marketplace, `claude plugin validate mod` il manifest e il modulo; il secondo esegue i test in `mod/tests/` con il kit `claude-code/testing`. Per provare la mod da questa cartella senza installarla: `claude --plugin-dir mod`.

### Disinstallazione

```bash
claude plugin uninstall auto-clear-context
```

Le cartelle `.claude/handoff/` nei progetti si possono cancellare a mano.

---

## License / Licenza

[MIT](LICENSE)
