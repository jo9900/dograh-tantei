# Codebase Memory

Dograh Tantei includes the pinned `codebase-memory-mcp` development dependency.
It indexes source symbols and their relationships for coding agents. The testing
application and its embedded Pi assistant do not depend on this MCP server.

## Index and inspect

From the repository root:

```bash
npm ci
npm run memory:index
npm run memory:status
npm run memory:architecture
```

The first use may download the platform executable from the upstream release and
verify its checksum. Indexing and queries then run locally, without model API keys.
The index name is `dograh-tantei`; rebuild it after moving files or changing interfaces.
This wrapper selects full indexing and disables exporting a graph artifact into
the repo. Local indexes use the tool's cache, normally `~/.cache/codebase-memory-mcp/`.

`.cbmignore` excludes credentials, dependencies, build output, recordings and local
evidence. `.gitignore` also excludes generated graph artifacts. The wrapper does not
load the application's `.env` file.

## Coding agents

- **Codex:** the repository includes `.codex/config.toml`. Open this as a trusted
  project, then restart the coding session so the `codebase-memory` server is loaded.
  No global Codex configuration is changed.
- **Claude Code:** the repository includes `.mcp.json`. Open the repository root
  and enable its project MCP configuration when prompted by the client.
- **Other MCP clients:** use `node scripts/codebase-memory.mjs serve`, with the
  repository root as the working directory.

Check MCP status in your client. You can ask the agent to inspect the
`dograh-tantei` architecture or trace callers of `evaluateCall`. Existing sessions
may need to restart before newly added tools appear; the CLI commands above work
without that restart.

The index supports navigation, while [architecture.md](architecture.md) holds
reviewable project context. Hindsight conversation memory, if installed separately,
is independent. Neither memory system is proof that a test or a remote change happened.

References: [Codebase Memory documentation](https://github.com/DeusData/codebase-memory-mcp),
[Codex project MCP configuration](https://developers.openai.com/codex/mcp/).
