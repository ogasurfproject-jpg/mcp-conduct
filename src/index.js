// mcp-conduct: check an MCP server's conduct before an agent connects to it.
//
// What it reads: the MCP Verification Gate (https://gate.horizonshield.dev), a free public instrument that
// measures five conditions on an MCP server (speaks MCP, publishes an A2A agent card, states who pays its
// operator, answers the same call the same way twice, and issues a verdict anyone can recompute).
//
// What it does not do: it does not measure anything itself, does not phone home, does not rank, and never
// turns "not measured" into "failed". The gate's own vocabulary is kept: verified true only on a full pass,
// null otherwise, never false. This library adds one thing on top: a policy, chosen by the caller, that
// decides whether the agent connects. The default policy warns and never blocks.
//
// Zero dependencies. Node 18+ (global fetch, crypto.subtle).

const DEFAULT_GATE = "https://gate.horizonshield.dev";
const STATES = ["verified", "pending", "held", "watched", "absent"];
const POLICIES = ["warn", "measured", "verified-only", "off"];

export class ConductBlocked extends Error {
  constructor(verdict, policy) {
    const st = verdict && verdict.state ? verdict.state : "unknown";
    super("mcp-conduct: connection to " + (verdict && verdict.endpoint) + " blocked by policy '" + policy + "': state is " + st +
      (verdict && verdict.reason ? " (" + verdict.reason + ")" : ""));
    this.name = "ConductBlocked";
    this.verdict = verdict;
    this.policy = policy;
  }
}

function assertHttps(endpoint) {
  let u;
  try { u = new URL(endpoint); } catch (_e) { throw new TypeError("mcp-conduct: endpoint must be an absolute URL, got " + JSON.stringify(endpoint)); }
  if (u.protocol !== "https:") throw new TypeError("mcp-conduct: endpoint must be https, got " + u.protocol);
  return u.toString();
}

async function sha256hex(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Recompute a gate verdict's record_sha256 exactly as the gate publishes the method:
// remove record_sha256 and recompute_note, JSON.stringify the rest in key order, SHA-256.
export async function recomputeRecordSha256(record) {
  if (!record || typeof record !== "object") return null;
  const body = {};
  for (const k of Object.keys(record)) {
    if (k === "record_sha256" || k === "recompute_note") continue;
    body[k] = record[k];
  }
  return await sha256hex(JSON.stringify(body));
}

// Decide under a policy. Returns { allow: boolean, why: string }.
export function decide(verdict, policy) {
  const state = verdict && verdict.state ? String(verdict.state) : "absent";
  const verified = !!(verdict && verdict.verified === true);
  switch (policy) {
    case "off":
      return { allow: true, why: "policy off: not consulted" };
    case "warn":
      return { allow: true, why: verified ? "verified" : "policy warn: state " + state + ", connecting anyway" };
    case "measured":
      // Block only what was measured and did not fully pass. Never measured (absent, watched) and could not be
      // measured (held) are not verdicts, so they pass through with a warning.
      if (verified) return { allow: true, why: "verified" };
      if (state === "pending") return { allow: false, why: "measured and not fully passed (pending)" };
      return { allow: true, why: "policy measured: state " + state + " is not a verdict, connecting" };
    case "verified-only":
      return verified ? { allow: true, why: "verified" } : { allow: false, why: "policy verified-only: state " + state };
    default:
      throw new TypeError("mcp-conduct: unknown policy " + JSON.stringify(policy) + "; one of " + POLICIES.join(", "));
  }
}

export function conductGate(options) {
  const opts = Object.assign({
    gate: DEFAULT_GATE,
    policy: "warn",
    timeoutMs: 6000,
    cacheTtlMs: 5 * 60 * 1000,
    fetch: globalThis.fetch,
    log: (msg) => console.warn(msg),
    userAgent: "mcp-conduct/0.1.0 (+https://github.com/ogasurfproject-jpg/mcp-conduct)"
  }, options || {});
  if (!POLICIES.includes(opts.policy)) throw new TypeError("mcp-conduct: unknown policy " + JSON.stringify(opts.policy) + "; one of " + POLICIES.join(", "));
  if (typeof opts.fetch !== "function") throw new TypeError("mcp-conduct: no fetch available; pass options.fetch");
  const base = String(opts.gate).replace(/\/+$/, "");
  const cache = new Map();

  async function http(method, path, body) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), opts.timeoutMs);
    try {
      const res = await opts.fetch(base + path, {
        method,
        headers: Object.assign({ "accept": "application/json", "user-agent": opts.userAgent },
          body ? { "content-type": "application/json" } : {}),
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal
      });
      let json = null;
      try { json = await res.json(); } catch (_e) { json = null; }
      return { status: res.status, json };
    } finally {
      clearTimeout(t);
    }
  }

  // Read the stored verdict for one endpoint (the register's latest scheduled measurement). Never measures.
  async function check(endpoint) {
    const ep = assertHttps(endpoint);
    const hit = cache.get(ep);
    if (hit && hit.until > Date.now()) return hit.verdict;
    let verdict;
    try {
      const r = await http("GET", "/is-verified?endpoint=" + encodeURIComponent(ep));
      if (r.status !== 200 || !r.json || typeof r.json !== "object") {
        verdict = { endpoint: ep, state: "unavailable", verified: null, reason: "gate answered http " + r.status + "; not a verdict about the server", gate_error: true };
      } else {
        verdict = r.json;
        if (!STATES.includes(verdict.state)) verdict = Object.assign({}, verdict, { state: "absent" });
      }
    } catch (e) {
      verdict = { endpoint: ep, state: "unavailable", verified: null, reason: "gate not reached: " + String(e && e.message || e) + "; not a verdict about the server", gate_error: true };
    }
    cache.set(ep, { verdict, until: Date.now() + opts.cacheTtlMs });
    return verdict;
  }

  // Read the register for many endpoints in one call (cap 50 per call on the gate side).
  async function checkMany(endpoints) {
    const eps = Array.from(new Set((endpoints || []).map(assertHttps)));
    const out = [];
    for (let i = 0; i < eps.length; i += 50) {
      const slice = eps.slice(i, i + 50);
      const r = await http("POST", "/feed/batch", { endpoints: slice });
      const results = r.status === 200 && r.json && Array.isArray(r.json.results) ? r.json.results : [];
      for (const ep of slice) {
        const row = results.find((x) => x && x.endpoint === ep) || null;
        out.push(row || { endpoint: ep, state: "unavailable", verified: null, reason: "no row in batch answer (http " + r.status + ")", gate_error: true });
      }
    }
    return out;
  }

  // Take a fresh measurement instead of the stored one, and recompute its hash here. Never asserts consent:
  // determinism is measured only when the server's own origin publishes /.well-known/mcp-conduct.json.
  async function checkFresh(endpoint) {
    const ep = assertHttps(endpoint);
    const r = await http("POST", "/check", { endpoint: ep });
    if (r.status !== 200 || !r.json || typeof r.json !== "object" || !r.json.status) {
      return { endpoint: ep, state: "unavailable", verified: null, reason: "gate answered http " + r.status + "; not a verdict about the server", gate_error: true, record: r.json };
    }
    const record = r.json;
    const recomputed = await recomputeRecordSha256(record);
    const state = record.status === "verified" ? "verified" : (record.status === "held" ? "held" : "pending");
    return {
      endpoint: ep,
      state,
      verified: state === "verified" ? true : null,
      measured_at: record.checked_at || null,
      record_sha256: record.record_sha256 || null,
      recomputed_matches: !!record.record_sha256 && recomputed === record.record_sha256,
      consent_source: record.consent_source || null,
      record
    };
  }

  // Policy on a verdict. Throws ConductBlocked when the policy says no.
  function enforce(verdict, policyOverride) {
    const policy = policyOverride || opts.policy;
    const d = decide(verdict, policy);
    if (!d.allow) throw new ConductBlocked(verdict, policy);
    if (policy !== "off" && verdict && verdict.verified !== true && typeof opts.log === "function") {
      opts.log("mcp-conduct: " + verdict.endpoint + " is " + (verdict.state || "unknown") + " on the gate (" + d.why + ")" +
        (verdict.reason ? ": " + verdict.reason : ""));
    }
    return d;
  }

  // check + enforce in one call. Resolves to the verdict, or throws ConductBlocked.
  async function assert(endpoint, policyOverride) {
    const v = await check(endpoint);
    enforce(v, policyOverride);
    return v;
  }

  // Wrap an MCP SDK client so that client.connect(transport) consults the gate first. The endpoint is taken
  // from the transport when it exposes one (StreamableHTTPClientTransport keeps its URL), else pass it.
  function guard(client, endpoint) {
    const original = client.connect.bind(client);
    client.connect = async function (transport, ...rest) {
      const ep = endpoint || transportUrl(transport);
      if (ep) await assert(ep);
      else if (typeof opts.log === "function") opts.log("mcp-conduct: no https endpoint found on the transport; nothing checked");
      return original(transport, ...rest);
    };
    return client;
  }

  return { check, checkMany, checkFresh, enforce, assert, guard, decide: (v, p) => decide(v, p || opts.policy), options: opts };
}

function transportUrl(transport) {
  if (!transport || typeof transport !== "object") return null;
  for (const k of ["_url", "url", "endpoint", "baseUrl"]) {
    const v = transport[k];
    if (v instanceof URL) return v.protocol === "https:" ? v.toString() : null;
    if (typeof v === "string" && /^https:\/\//i.test(v)) return v;
  }
  return null;
}

export { DEFAULT_GATE, STATES, POLICIES };
