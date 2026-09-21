# Dograh Tantei

Local voice-agent testing workbench: React UI, Node controller, Python audio bridge.
Read [docs/architecture.md](docs/architecture.md) for module boundaries and
[docs/codebase-memory.md](docs/codebase-memory.md) for code indexing.

## Working on the code

- Keep `src/App.tsx` focused on shell composition. Feature UI belongs in
  `src/features`, shared controls in `src/components`, and the API/event lifecycle
  in `src/hooks/useWorkbench.ts`.
- Keep styles in the matching `src/styles` module. `src/styles.css` records their
  cascade order; check desktop and narrow-screen layouts after CSS changes.
- Keep the controller, evidence parsing, pure judgments and paid model calls
  separate. Preserve `server/intelligence.ts` as the evaluation entry point.
- Run `npm run typecheck`, `npm test`, `npm run build` and `npm run format:check`.
  Python audio changes also need `.venv/bin/python -m unittest audio_worker.test_worker`.
- Preserve existing local data under `~/.tantei` and `TANTEI_*` environment keys.
  Project branding is **Dograh Tantei**; the package/repository name is `dograh-tantei`.

## Codebase Memory

- Use the configured `codebase-memory` MCP for structural questions. Check index
  status first; use `npm run memory:index` after significant structural changes.
- Query the `dograh-tantei` project. Use architecture, symbol and call-path results
  to choose files, then read the exact source before editing.
- An index is navigation evidence, not proof of behavior or exhaustive coverage.
  Check coverage/skips before making absence claims; tests and source remain authoritative.
- Do not index or commit credentials, `.env`, Pi authentication, recordings, or
  local call evidence. Keep generated graph/cache files out of version control.
- Keep durable architecture decisions in the repository docs so colleagues can
  reproduce the context without sharing a machine-local memory cache.

## Product invariants

- GPT-Live 1 is the simulated caller; Dograh is the AI service agent. Use generic
  role names because workflows cover different business scenarios.
- Make the test goal and result clear. Use Dograh's saved transcript and Gathered
  Context for judgments, and offer the complete Dograh recording for playback.
  For final-field goals, compare the corresponding context field with the target;
  do not invent requirements for external database or tool-execution evidence.
- Pi and Jev produce separate judgments. The backend calls Jev directly through
  TypeSafe; Pi does not call a Jev skill. Pi summaries summarize Pi reviews.
- Keep user-facing results concise. Do not reintroduce separate recording
  transcription, raw event IDs, audio slices, or generic evidence disclaimers.
  Keep technical diagnostics in developer-facing records.
- Calls are always listed in task details. Display call IDs as `#123` and distinguish
  passed, failed and inconclusive results with both icons and text.
- Preserve recordings, timestamps, workflow versions and prior review revisions.
  Re-review uses saved Dograh evidence without redialing or new transcription
  requests. Real paid calls need a user-requested budget.
- Keep Pi conversations scoped to the workbench or one task. Resume the matching
  saved session on return; never mix task histories or workflow-edit permissions.
- Deleting a task also deletes its Pi conversation, after active work has ended.
  Other conversations and saved recording files remain untouched.
- Pi workflow writes remain limited to the explicitly authorized draft and chat
  turn, with baseline checks and backups. Never publish a workflow automatically.
- Never expose credentials in browser state, logs, screenshots or committed files.

## Repository documentation and artifacts

- `README.md` is the English entry point; keep `README.zh-CN.md` and `README.ja.md`
  aligned with user-visible behavior. Link to the upstream Dograh project.
- Keep durable architecture and integration contracts in `docs/`. Update them
  when behavior changes; do not treat historical experiments as current features.
- Keep `mockups/`, `.impeccable/`, `output/`, local validation logs and dated
  research notes out of Git. Preserve local copies when removing tracked artifacts.
- Commit `.env.example` with placeholders only. Never commit `.env`, credentials,
  recordings, runtime data, dependency folders, build output or generated indexes.
- Do not add a license or change repository visibility without user instruction.
