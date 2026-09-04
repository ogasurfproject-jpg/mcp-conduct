# mcp-conduct

Check an MCP server's conduct before your agent connects to it. One GET to a free public instrument, a hash you
recompute yourself, and a policy you choose. Zero dependencies, Node 18+.

```js
import { conductGate } from "mcp-conduct";

const gate = conductGate({ policy: "measured" });
await gate.assert("https://some-server.example/mcp");   // throws ConductBlocked if the policy says no
```

Or wrap an MCP SDK client once and forget about it:

```js
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { conductGate } from "mcp-conduct";

const client = conductGate({ policy: "measured" }).guard(new Client({ name: "my-agent", version: "1.0.0" }));
await client.connect(new StreamableHTTPClientTransport(new URL("https://some-server.example/mcp")));
// the gate was consulted before the connection was opened
```

## What is read

The [MCP Verification Gate](https://gate.horizonshield.dev/spec) measures five conditions on an MCP server, on a
schedule, and publishes the result with a hash: the server speaks MCP (initialize, tools/list), publishes an A2A
agent card, states in that card who compensates its operator, answers the same tool call the same way twice,
and the verdict itself can be recomputed by anyone. The gate is free, needs no key, and is not sold or ranked.

`gate.check(endpoint)` reads the stored verdict (`GET /is-verified`). It never measures anything and never
tells the server it was asked. The answer keeps the gate's vocabulary:

| `state` | `verified` | meaning |
|---|---|---|
| `verified` | `true` | the latest scheduled measurement passed every measured condition |
| `pending` | `null` | measured, and at least one condition did not pass or was not measured |
| `held` | `null` | the server, or the gate's relay, could not be reached; not a verdict |
| `watched` | `null` | on the register, not measured yet |
| `absent` | `null` | never measured; absence is not a negative verdict |
| `unavailable` | `null` | this library could not read the gate; not a statement about the server |

`verified` is `true` or `null`, never `false`. That is the gate's rule and this library does not soften it.

## Policies

The policy is yours. The library only refuses to invent a verdict.

| policy | connects when | blocks when |
|---|---|---|
| `warn` (default) | always; logs a line unless verified | never |
| `measured` | verified, absent, watched, held, unavailable | `pending` only: measured and not fully passed |
| `verified-only` | `verified` only | everything else, including a gate outage |
| `off` | always, without asking | never |

`measured` is the honest strict setting: it blocks what was measured and failed, and lets through what was
never measured, because "not measured" is not "failed". `verified-only` is for closed deployments that would
rather not connect at all than connect to something unmeasured; note that it also blocks when the gate itself is
down, by design.

## API

```ts
conductGate(options?: {
  gate?: string;          // default https://gate.horizonshield.dev
  policy?: "warn" | "measured" | "verified-only" | "off";
  timeoutMs?: number;     // default 6000
  cacheTtlMs?: number;    // default 300000; verdicts are cached per endpoint
  fetch?: typeof fetch;   // default globalThis.fetch
  log?: (msg: string) => void; // default console.warn; pass null to silence
})
```

`check(endpoint)` stored verdict. `checkMany(endpoints)` the same for up to any number of endpoints, 50 per call to
the gate, input order kept. `assert(endpoint, policy?)` check then enforce. `enforce(verdict, policy?)` apply the
policy to a verdict you already hold. `guard(client, endpoint?)` wrap an MCP SDK client so `connect` consults the
gate first; the endpoint is read from the transport's URL when it has one. `decide(verdict, policy)` the pure
policy table, exported for your own tests.

`checkFresh(endpoint)` takes a fresh measurement (`POST /check`) instead of the stored one and recomputes the
verdict's `record_sha256` on your machine (`recomputed_matches`). It never asserts consent for tool calls: the
gate measures determinism only when the server's own origin publishes `/.well-known/mcp-conduct.json` with
`{"allow_tool_call": true}`, which only the owner can place. The returned `consent_source` tells you which case
applied, and a verdict without consent names that path so an operator knows what to do.

`recomputeRecordSha256(record)` is the gate's published method: remove `record_sha256` and `recompute_note`,
`JSON.stringify` the rest in key order, SHA-256. It is exported so you can check any verdict you were handed.

## What this does not do

It does not measure servers, does not send your endpoints anywhere but the gate, does not phone home, does not
rank, and does not claim that a verified server is safe, correct, or competent. A verdict is a measurement of
conduct and disclosure taken at a stated time; the next measurement can revoke it. The gate's own servers sit on
the same register and can fail on it: https://gate.horizonshield.dev/self

## For operators who want their row

Two files on your side and nothing to ask anyone: a `compensation` block in your agent card
(`paid_by`, `referral_fee`, `listing_fee`, filled truthfully; the content is not judged, only its absence) and
`/.well-known/mcp-conduct.json` on your origin with `{"allow_tool_call": true}`. Then `POST /watch` once, or set
`join_register` in the CI step: https://github.com/ogasurfproject-jpg/mcp-conduct-action

MIT. The HORIZONs Co., Ltd., Hiratsuka, Japan.
