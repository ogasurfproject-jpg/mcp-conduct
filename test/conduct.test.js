import { test } from "node:test";
import assert from "node:assert/strict";
import { conductGate, decide, recomputeRecordSha256, ConductBlocked } from "../src/index.js";

const EP = "https://server.example/mcp";

function mockFetch(routes) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    const u = new URL(url);
    const key = u.pathname;
    const h = routes[key];
    if (!h) return new Response("not found", { status: 404 });
    const body = init && init.body ? JSON.parse(init.body) : null;
    const out = await h(u, body);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  };
  f.calls = calls;
  return f;
}

const verifiedRow = (ep) => ({ endpoint: ep, state: "verified", verified: true, measured_at: "2026-09-04T18:00:00Z", record_sha256: "ab".repeat(32), on_register: true });
const pendingRow = (ep) => ({ endpoint: ep, state: "pending", verified: null, measured_at: "2026-09-04T18:00:00Z", record_sha256: "cd".repeat(32), on_register: true, reason: "determinism not measured" });
const absentRow = (ep) => ({ endpoint: ep, state: "absent", verified: null, on_register: false, reason: "No measurement exists here for this endpoint. Absence is not a negative verdict." });
const heldRow = (ep) => ({ endpoint: ep, state: "held", verified: null, on_register: true, reason: "unreachable" });

test("decide: the policy table", () => {
  const V = { state: "verified", verified: true }, P = { state: "pending", verified: null }, A = { state: "absent", verified: null }, H = { state: "held", verified: null }, U = { state: "unavailable", verified: null, gate_error: true };
  for (const v of [V, P, A, H, U]) assert.equal(decide(v, "off").allow, true);
  for (const v of [V, P, A, H, U]) assert.equal(decide(v, "warn").allow, true);
  assert.equal(decide(V, "measured").allow, true);
  assert.equal(decide(P, "measured").allow, false);
  assert.equal(decide(A, "measured").allow, true);
  assert.equal(decide(H, "measured").allow, true);
  assert.equal(decide(U, "measured").allow, true);
  assert.equal(decide(V, "verified-only").allow, true);
  for (const v of [P, A, H, U]) assert.equal(decide(v, "verified-only").allow, false);
  assert.throws(() => decide(V, "strict"), TypeError);
});

test("verified is never derived from anything but verified === true", () => {
  // a row that says state verified but verified false or missing must not pass verified-only
  assert.equal(decide({ state: "verified", verified: false }, "verified-only").allow, false);
  assert.equal(decide({ state: "verified" }, "verified-only").allow, false);
  assert.equal(decide({ state: "verified", verified: "true" }, "verified-only").allow, false);
});

test("check reads /is-verified once and caches", async () => {
  const f = mockFetch({ "/is-verified": (u) => verifiedRow(u.searchParams.get("endpoint")) });
  const g = conductGate({ fetch: f, log: null });
  const a = await g.check(EP);
  const b = await g.check(EP);
  assert.equal(a.state, "verified");
  assert.equal(b, a);
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].url, /\/is-verified\?endpoint=https%3A%2F%2Fserver\.example%2Fmcp$/);
  assert.equal(f.calls[0].init.headers["user-agent"].startsWith("mcp-conduct/"), true);
});

test("endpoint must be https", async () => {
  const g = conductGate({ fetch: mockFetch({}), log: null });
  await assert.rejects(() => g.check("http://server.example/mcp"), TypeError);
  await assert.rejects(() => g.check("server.example/mcp"), TypeError);
});

test("gate unreachable is unavailable, not a verdict; warn and measured let it through, verified-only does not", async () => {
  const boom = async () => { throw new Error("ECONNREFUSED"); };
  const logs = [];
  const g = conductGate({ fetch: boom, log: (m) => logs.push(m), cacheTtlMs: 0 });
  const v = await g.check(EP);
  assert.equal(v.state, "unavailable");
  assert.equal(v.verified, null);
  assert.equal(v.gate_error, true);
  assert.match(v.reason, /not a verdict about the server/);
  assert.equal(g.enforce(v, "warn").allow, true);
  assert.equal(g.enforce(v, "measured").allow, true);
  assert.throws(() => g.enforce(v, "verified-only"), ConductBlocked);
  assert.equal(logs.length >= 1, true);
});

test("gate answers 500: unavailable, same handling", async () => {
  const f = mockFetch({ "/is-verified": () => new Response("boom", { status: 500 }) });
  const g = conductGate({ fetch: f, log: null });
  const v = await g.check(EP);
  assert.equal(v.state, "unavailable");
  assert.equal(v.gate_error, true);
});

test("unknown state from the gate is treated as absent, never as verified", async () => {
  const f = mockFetch({ "/is-verified": (u) => ({ endpoint: u.searchParams.get("endpoint"), state: "golden", verified: true }) });
  const g = conductGate({ fetch: f, log: null });
  const v = await g.check(EP);
  assert.equal(v.state, "absent");
});

test("assert throws ConductBlocked under measured when pending, carries the verdict", async () => {
  const f = mockFetch({ "/is-verified": (u) => pendingRow(u.searchParams.get("endpoint")) });
  const g = conductGate({ fetch: f, policy: "measured", log: null });
  await assert.rejects(() => g.assert(EP), (e) => e instanceof ConductBlocked && e.verdict.state === "pending" && e.policy === "measured" && /blocked by policy 'measured'/.test(e.message));
  // absent passes under measured with a warning
  const f2 = mockFetch({ "/is-verified": (u) => absentRow(u.searchParams.get("endpoint")) });
  const logs = [];
  const g2 = conductGate({ fetch: f2, policy: "measured", log: (m) => logs.push(m) });
  const v = await g2.assert(EP);
  assert.equal(v.state, "absent");
  assert.equal(logs.length, 1);
  assert.match(logs[0], /absent/);
});

test("verified emits no log line", async () => {
  const f = mockFetch({ "/is-verified": (u) => verifiedRow(u.searchParams.get("endpoint")) });
  const logs = [];
  const g = conductGate({ fetch: f, policy: "verified-only", log: (m) => logs.push(m) });
  await g.assert(EP);
  assert.equal(logs.length, 0);
});

test("guard wraps client.connect and consults the gate first", async () => {
  const f = mockFetch({ "/is-verified": (u) => (u.searchParams.get("endpoint").includes("bad") ? pendingRow(u.searchParams.get("endpoint")) : verifiedRow(u.searchParams.get("endpoint"))) });
  const g = conductGate({ fetch: f, policy: "measured", log: null });
  const connected = [];
  const client = { connect: async (t) => { connected.push(t); return "ok"; } };
  g.guard(client);
  const good = { _url: new URL("https://good.example/mcp") };
  const bad = { _url: new URL("https://bad.example/mcp") };
  assert.equal(await client.connect(good), "ok");
  await assert.rejects(() => client.connect(bad), ConductBlocked);
  assert.deepEqual(connected, [good]);
  // explicit endpoint wins over the transport
  const client2 = { connect: async () => "ok" };
  g.guard(client2, "https://bad.example/mcp");
  await assert.rejects(() => client2.connect({}), ConductBlocked);
});

test("guard without an https endpoint checks nothing and says so", async () => {
  const f = mockFetch({});
  const logs = [];
  const g = conductGate({ fetch: f, policy: "verified-only", log: (m) => logs.push(m) });
  const client = { connect: async () => "ok" };
  g.guard(client);
  assert.equal(await client.connect({ command: "node", args: ["server.js"] }), "ok");
  assert.equal(f.calls.length, 0);
  assert.match(logs[0], /nothing checked/);
});

test("checkMany batches by 50 and keeps input order; missing rows are unavailable", async () => {
  const f = mockFetch({ "/feed/batch": (_u, body) => ({ count: body.endpoints.length, results: body.endpoints.filter((e) => !e.includes("silent")).map((e) => (e.includes("v") ? verifiedRow(e) : absentRow(e))) }) });
  const g = conductGate({ fetch: f, log: null });
  const eps = [];
  for (let i = 0; i < 120; i++) eps.push("https://h" + i + (i % 3 === 0 ? "v" : "") + ".example/mcp");
  eps.push("https://silent.example/mcp");
  const rows = await g.checkMany(eps);
  assert.equal(rows.length, 121);
  assert.equal(f.calls.length, 3);
  assert.equal(rows[0].state, "verified");
  assert.equal(rows[1].state, "absent");
  assert.equal(rows[120].state, "unavailable");
  for (let i = 0; i < 121; i++) assert.equal(rows[i].endpoint, eps[i]);
});

test("recomputeRecordSha256 reproduces the gate's method and detects an altered record", async () => {
  const record = { gate: "MCP Verification Gate", endpoint: EP, status: "verified", checks: { a: { pass: true } }, note: "日本語" };
  const sha = await recomputeRecordSha256(record);
  record.record_sha256 = sha;
  record.recompute_note = "ignored";
  assert.equal(await recomputeRecordSha256(record), sha);
  // independent reference: node's crypto over the same bytes
  const { createHash } = await import("node:crypto");
  const ref = createHash("sha256").update(JSON.stringify({ gate: record.gate, endpoint: EP, status: "verified", checks: { a: { pass: true } }, note: "日本語" })).digest("hex");
  assert.equal(sha, ref);
  const tampered = Object.assign({}, record, { status: "pending" });
  assert.notEqual(await recomputeRecordSha256(tampered), sha);
});

test("checkFresh posts /check without allow_tool_call, recomputes, and reports consent_source", async () => {
  const f = mockFetch({ "/check": async (_u, body) => {
    const rec = { gate: "MCP Verification Gate", gate_version: "0.2.4", endpoint: body.endpoint, checked_at: "2026-09-04T18:00:00Z", status: "pending",
      consent_basis: "no consent given; no tool was called", consent_source: "none",
      consent_lookup: { well_known: "https://server.example/.well-known/mcp-conduct.json", result: "no consent file (http 404)", how_to_consent: "Publish ..." },
      checks: { mcp_endpoint: { pass: true }, determinism: { pass: false, measured: false } } };
    rec.record_sha256 = await recomputeRecordSha256(rec);
    rec.recompute_note = "...";
    return rec;
  } });
  const g = conductGate({ fetch: f, log: null });
  const v = await g.checkFresh(EP);
  assert.equal(JSON.parse(f.calls[0].init.body).allow_tool_call, undefined);
  assert.equal(v.state, "pending");
  assert.equal(v.verified, null);
  assert.equal(v.recomputed_matches, true);
  assert.equal(v.consent_source, "none");
  assert.equal(v.record.consent_lookup.result.includes("404"), true);
});

test("checkFresh flags a record that does not hash to its own record_sha256", async () => {
  const f = mockFetch({ "/check": async (_u, body) => ({ status: "verified", endpoint: body.endpoint, checks: {}, record_sha256: "00".repeat(32) }) });
  const g = conductGate({ fetch: f, log: null });
  const v = await g.checkFresh(EP);
  assert.equal(v.state, "verified");
  assert.equal(v.recomputed_matches, false);
});

test("timeout aborts and yields unavailable", async () => {
  const slow = (url, init) => new Promise((_res, rej) => { init.signal.addEventListener("abort", () => rej(new Error("aborted"))); });
  const g = conductGate({ fetch: slow, timeoutMs: 20, log: null });
  const v = await g.check(EP);
  assert.equal(v.state, "unavailable");
  assert.match(v.reason, /aborted/);
});

test("bad options are rejected up front", () => {
  assert.throws(() => conductGate({ policy: "block" }), TypeError);
  assert.throws(() => conductGate({ fetch: null }), TypeError);
});
