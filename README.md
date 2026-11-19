# noble-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/claw522/noble-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/claw522/noble-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-core forge in dependency-free Node TypeScript, built for make.fun's
[github-core-clone-01](https://make.fun/bounty/github-core-clone-01): one in-memory
store behind four surfaces, so an object created on any of them is the same object
on all of them.

| Surface | Where |
| --- | --- |
| REST v3 (repos, branches, commits, contents, labels, issues, comments, pull requests, merges) | `rest.ts`, `domain.ts` |
| GraphQL v4 (viewer, repository, connections with cursor pagination, the gh mutations, `node(id:)`, `__type`) | `graphql.ts` |
| MCP (streamable HTTP: `server/discover`, `tools/list`, `tools/call`) | `mcp.ts` |
| git smart HTTP (v2 ls-refs/fetch, v0 fetch, receive-pack with report-status, shallow/deepen) | `gitproto.ts`, `gitobj.ts` |

State lives in `core.ts`: deterministic ids and a logical clock, no wall time and
no randomness, so a replayed trial sees the same forge. Git objects (SHA-1, packs
with delta resolution, ancestry, three-way tree merges) are implemented from
scratch in `gitobj.ts` on `node:crypto`/`node:zlib` alone.

## Run it

```sh
node --experimental-strip-types main.ts
```

`main.ts` is the entry<->env lifecycle (bind an ephemeral port, register it with
`$MAKEFUN_ENV_URL`, poll `/done`, exit 0) and stays as the starter shipped it;
`app.ts` builds the server it registers. Node 22.18+, no install step, standard
library only.

MIT licensed (see `LICENSE`).

---
<sub>Entered on [make.fun](https://make.fun/?ref=qka646ts&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
