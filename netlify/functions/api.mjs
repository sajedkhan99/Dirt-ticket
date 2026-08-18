
// Dirt Ticket — the entire backend in one file.
//
// Serves three endpoints and exports the scrape routine for the cron function:
//   GET  /api/leads    what the board reads
//   GET  /api/scrape   run a scrape now, returns the log
//   POST /api/draft    AI reply drafting

import { getStore } from "@netlify/blobs";

// Shared scraping logic for the Netlify functions.
//
// Scheduled functions get 30 seconds, so nothing here runs unbounded: every
// source checks the remaining budget before each request and stops cleanly.
// Whatever it collected still gets saved.

const UA = "Mozilla/5.0 (compatible; DirtTicketLeadBot/1.0)";

const KEYWORDS = {
  "retaining wall": 5, "retaining walls": 5, "block wall": 4, "boulder wall": 4,
  "segmental": 3, "gabion": 3, "erosion": 3, "washing out": 4, "washout": 3,
  "slope": 2, "grading": 3, "regrade": 3, "excavation": 3, "excavating": 3,
  "dirt work": 4, "dirt haul": 4, "haul off": 4, "hauling": 3, "dump truck": 3,
  "end dump": 4, "select fill": 4, "fill dirt": 4, "spoil": 3, "topsoil": 2,
  "drainage": 2, "french drain": 2, "pad site": 3, "site work": 3, "sitework": 3,
  "land clearing": 4, "demolition": 3, "skid steer": 3, "backhoe": 3,
  quote: 3, bids: 3, bid: 2, estimate: 3, "looking for": 2, need: 2,
  hiring: 3, "sub needed": 5, subcontractor: 4, asap: 2, insured: 2,
};

const NEGATIVE = [
  "for sale", "selling", "resume", "looking for work", "seeking employment",
  "we offer", "our company provides", "cash for", "wanted to buy",
];

const DFW_PLACES = [
  "dallas", "fort worth", "ft worth", "arlington", "plano", "frisco", "mckinney",
  "denton", "irving", "garland", "mesquite", "carrollton", "richardson", "allen",
  "prosper", "celina", "little elm", "the colony", "lewisville", "flower mound",
  "grapevine", "southlake", "keller", "mansfield", "waxahachie", "rockwall",
  "wylie", "anna", "melissa", "royse city", "princeton", "burleson", "dfw",
];

const CITY_CASE = { mckinney: "McKinney", dfw: "DFW", "ft worth": "Fort Worth",
  "fort worth": "Fort Worth", "the colony": "The Colony" };

function score(text) {
  const low = (text || "").toLowerCase();
  if (NEGATIVE.some((n) => low.includes(n))) return [0, []];
  let pts = 0;
  const hits = [];
  for (const [kw, w] of Object.entries(KEYWORDS)) {
    if (low.includes(kw)) { pts += w; hits.push(kw); }
  }
  if (DFW_PLACES.some((p) => low.includes(p))) pts += 1;
  return [Math.min(pts, 10), hits.slice(0, 5)];
}

function guessLocation(text) {
  const low = (text || "").toLowerCase();
  const hit = DFW_PLACES.find((p) => low.includes(p));
  if (!hit) return "DFW";
  return CITY_CASE[hit] || hit.replace(/\b\w/g, (c) => c.toUpperCase());
}

function leadId(url, title) {
  let h = 0;
  const s = url + title;
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
  return "l" + Math.abs(h).toString(36) + s.length.toString(36);
}

// --- budget guard -----------------------------------------------------------

function makeBudget(ms) {
  const start = Date.now();
  return {
    left: () => ms - (Date.now() - start),
    ok: (need = 1500) => ms - (Date.now() - start) > need,
    used: () => Date.now() - start,
  };
}

async function get(url, { json = true, headers = {}, timeout = 8000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, ...headers },
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`${r.status}`);
    return json ? await r.json() : await r.text();
  } finally {
    clearTimeout(t);
  }
}

// --- permits (Socrata) ------------------------------------------------------

const PERMIT_DOMAINS = [
  ["Dallas", "www.dallasopendata.com"],
  ["Fort Worth", "data.fortworthtexas.gov"],
  ["DFW metro", "data.texas.gov"],
];

const PERMIT_TIERS = {
  9: ["RETAINING", "SEGMENTAL", "GABION", "EROSION", "SLOPE STABIL"],
  7: ["EXCAVAT", "GRADING", "EARTHWORK", "SITE WORK", "SITEWORK", "DRAINAGE",
      "DETENTION", "CUT AND FILL"],
  6: ["SWIMMING POOL", "POOL AND SPA", "DEMOLITION", "PAVING",
      "NEW SINGLE FAMILY", "FOUNDATION", "STORM SEWER"],
};
const TIER_LABEL = { 9: "wall work", 7: "dirt work", 6: "haul-off" };
const PERMIT_TERMS = Object.values(PERMIT_TIERS).flat();

const ROLE_PATTERNS = {
  desc: ["work_description", "description", "work_desc", "job_description"],
  ptype: ["permit_type", "type_of_permit", "permit_class", "work_type"],
  contractor: ["contractor", "applicant", "company", "business_name"],
  value: ["value", "estimated_cost", "valuation", "job_value", "cost"],
  issued: ["issued_date", "issued", "issue_date", "date_issued", "permit_date"],
  address: ["street_address", "address", "location_address", "site_address"],
  zipcode: ["zip_code", "zip", "postal_code", "zipcode"],
  number: ["permit_number", "permit_no", "permit", "record_number"],
};

const PHONE_RE = /\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;

function permitTier(text) {
  const up = (text || "").toUpperCase();
  for (const pts of [9, 7, 6]) {
    if (PERMIT_TIERS[pts].some((t) => up.includes(t))) return [pts, TIER_LABEL[pts]];
  }
  return [0, ""];
}

function socrataHeaders() {
  const tok = process.env.SOCRATA_APP_TOKEN;
  return tok ? { "X-App-Token": tok } : {};
}

async function discoverDatasets(budget, log) {
  const found = [{ city: "Dallas", domain: "www.dallasopendata.com", dataset: "e7gq-4sah" }];
  const have = new Set(found.map((d) => d.domain + d.dataset));

  for (const [city, domain] of PERMIT_DOMAINS) {
    if (!budget.ok(4000)) break;
    try {
      const res = await get(
        `https://api.us.socrata.com/api/catalog/v1?q=building%20permits&domains=${domain}&only=dataset&limit=20`,
        { headers: socrataHeaders() }
      );
      for (const item of res.results || []) {
        const r = item.resource || {};
        const name = (r.name || "").toLowerCase();
        if (!r.id || have.has(domain + r.id)) continue;
        if (!name.includes("permit")) continue;
        if (["summary", "dashboard", "count", "monthly"].some((x) => name.includes(x))) continue;
        have.add(domain + r.id);
        found.push({ city, domain, dataset: r.id, label: r.name });
      }
    } catch (e) {
      log(`discovery ${domain}: ${e.message}`);
    }
  }
  return found;
}

async function discoverSchema(domain, dataset) {
  const meta = await get(`https://${domain}/api/views/${dataset}.json`, { headers: socrataHeaders() });
  const fields = (meta.columns || [])
    .map((c) => [(c.fieldName || "").toLowerCase(), (c.name || "").toLowerCase().replace(/ /g, "_")])
    .filter(([fn]) => fn);

  const roles = {};
  for (const [role, pats] of Object.entries(ROLE_PATTERNS)) {
    for (const pat of pats) {
      const exact = fields.find(([fn, nm]) => fn === pat || nm === pat);
      const loose = fields.find(([fn, nm]) => fn.includes(pat) || nm.includes(pat));
      const hit = exact || loose;
      if (hit) { roles[role] = hit[0]; break; }
    }
  }
  return roles;
}

async function scrapePermits(seen, budget, log, datasets) {
  const out = [];
  for (const src of datasets) {
    if (!budget.ok(5000)) { log("permits: out of time"); break; }
    const { city, domain, dataset } = src;

    let roles;
    try { roles = await discoverSchema(domain, dataset); }
    catch (e) { log(`${city}/${dataset}: schema ${e.message}`); continue; }
    if (!roles.desc && !roles.ptype) continue;

    const targets = ["desc", "ptype"].filter((k) => roles[k]).map((k) => roles[k]);
    const where = encodeURIComponent(
      targets.flatMap((f) => PERMIT_TERMS.map((t) => `upper(${f}) like '%${t}%'`)).join(" OR ")
    );
    const base = `https://${domain}/resource/${dataset}.json?$where=${where}&$limit=200`;

    let rows;
    try {
      // :updated_at is a Socrata system field and always a real timestamp.
      // The city's own "issued" column is often plain text (08/14/26), which
      // sorts alphabetically by month and returns archive records at random.
      rows = await get(`${base}&$order=:updated_at DESC`, { headers: socrataHeaders() });
    } catch {
      try { rows = await get(base, { headers: socrataHeaders() }); }
      catch (e) { log(`${city}/${dataset}: query ${e.message}`); continue; }
    }

    let kept = 0;
    for (const row of rows) {
      const desc = String(row[roles.desc] ?? "").trim();
      const ptype = String(row[roles.ptype] ?? "").trim();
      const [tier, label] = permitTier(`${desc} ${ptype}`);
      if (!tier) continue;

      const permitNo = String(row[roles.number] ?? "").trim();
      const key = `${domain}-${permitNo || desc.slice(0, 50)}`;
      if (seen[key]) continue;
      seen[key] = 1;
      kept++;

      const contractor = String(row[roles.contractor] ?? "").trim();
      const phone = (contractor.match(PHONE_RE) || [""])[0];
      const name = contractor ? contractor.split(/\d{2,}\s/)[0].replace(/[,\s-]+$/, "") : "";
      const value = String(row[roles.value] ?? "").trim();
      const addr = String(row[roles.address] ?? "").trim();
      const zip = String(row[roles.zipcode] ?? "").trim();

      const bits = [];
      if (name) bits.push(`Contractor: ${name}`);
      if (phone) bits.push(`☎ ${phone}`);
      if (value) bits.push(`Value: $${value}`);
      if (addr) bits.push(addr);

      out.push({
        id: leadId(key, desc),
        title: (desc || ptype).slice(0, 130),
        snippet: bits.join(" · ") || `Permit ${permitNo}`,
        url: `https://${domain}/d/${dataset}`,
        source: "Permits",
        location: `${city} ${zip}`.trim(),
        posted: normalizeDate(String(row[roles.issued] ?? ""), row[":updated_at"]),
        score: tier,
        matched: [label, ptype.slice(0, 28)].filter(Boolean),
        phone,
        contractor: name,
      });
    }
    if (kept) log(`${city}/${dataset}: ${kept}`);
  }
  return out;
}

function normalizeDate(raw, fallback) {
  if (!raw) return fallback ? new Date(fallback).toISOString() : new Date().toISOString();
  const iso = Date.parse(raw);
  if (!isNaN(iso)) return new Date(iso).toISOString();
  const m = raw.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    const yr = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return new Date(Date.UTC(yr, m[1] - 1, +m[2])).toISOString();
  }
  return fallback ? new Date(fallback).toISOString() : new Date().toISOString();
}

// --- public bids ------------------------------------------------------------

const BID_URL = "https://ntsbdc.org/bid-opportunities/";
const BID_TERMS = ["retaining", "excavat", "grading", "earthwork", "site work",
  "sitework", "paving", "drainage", "demolition", "erosion", "storm sewer",
  "detention", "channel", "parking lot"];

async function scrapeBids(seen, budget, log) {
  if (!budget.ok(6000)) return [];
  let page;
  try { page = await get(BID_URL, { json: false, timeout: 9000 }); }
  catch (e) { log(`bids: ${e.message}`); return []; }

  const text = page
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&amp;/g, "&").replace(/&#8217;/g, "'").replace(/&nbsp;/g, " ");

  const out = [];
  for (const b of text.split(/\n\s*(?=Project:)/)) {
    const low = b.toLowerCase();
    if (!BID_TERMS.some((t) => low.includes(t))) continue;

    const grab = (label, next) => {
      const m = b.match(new RegExp(`${label}:\\s*([\\s\\S]+?)(?=\\s*${next}:|\\n\\n|$)`, "i"));
      return m ? m[1].replace(/\s+/g, " ").trim().slice(0, 200) : "";
    };
    const title = grab("Project", "Reference No");
    if (!title) continue;

    const key = "bid-" + leadId(title, grab("Location", "Bid Close Date"));
    if (seen[key]) continue;
    seen[key] = 1;

    const desc = grab("Project Description", "Details");
    const [pts, hits] = score(`${title} ${desc}`);
    const link = b.match(/https?:\/\/[^\s"'<>]+/);
    const close = grab("Bid Close Date", "Project Description");

    out.push({
      id: leadId(key, title),
      title: title.slice(0, 130),
      snippet: (close ? `Closes ${close}. ` : "") + desc.slice(0, 230),
      url: link ? link[0] : BID_URL,
      source: "Bids",
      location: grab("Location", "Bid Close Date").replace("City of ", "") || "DFW",
      posted: new Date().toISOString(),
      score: Math.max(pts, 6),
      matched: (hits.length ? hits : ["public bid"]).slice(0, 4),
    });
  }
  return out;
}

// --- reddit -----------------------------------------------------------------

const REDDIT_SUBS = [
  "Dallas", "FortWorth", "dfw", "Plano", "Frisco", "McKinney", "Denton",
  "Arlington", "Irving", "HomeImprovement", "landscaping", "Construction",
  "Hardscaping", "pools", "homeowners",
];
const GENERAL_SUBS = new Set(["HomeImprovement", "landscaping", "Construction",
  "Hardscaping", "pools", "homeowners"]);
const REDDIT_QUERIES = ["retaining wall", "dirt work", "excavation", "grading contractor"];

let tokenCache = { value: null, expires: 0 };

async function redditToken() {
  const id = process.env.REDDIT_ID, secret = process.env.REDDIT_SECRET;
  if (!id || !secret) return null;
  if (tokenCache.value && Date.now() < tokenCache.expires) return tokenCache.value;
  try {
    const r = await fetch("https://www.reddit.com/api/v1/access_token", {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${id}:${secret}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": UA,
      },
      body: "grant_type=client_credentials",
    });
    const d = await r.json();
    tokenCache = { value: d.access_token, expires: Date.now() + (d.expires_in || 3600) * 900 };
    return tokenCache.value;
  } catch { return null; }
}

async function scrapeReddit(seen, budget, log, pairs) {
  const tok = await redditToken();
  if (!tok) log("reddit: no OAuth creds — cloud IPs are often blocked without them");
  const out = [];

  for (const [sub, q] of pairs) {
    if (!budget.ok(3000)) { log("reddit: out of time"); break; }
    const path = `/r/${sub}/search.json?q=${encodeURIComponent(q)}&restrict_sr=1&sort=new&t=month&limit=25`;
    let data;
    try {
      data = tok
        ? await get("https://oauth.reddit.com" + path, { headers: { Authorization: `Bearer ${tok}` } })
        : await get("https://www.reddit.com" + path);
    } catch (e) { log(`r/${sub} "${q}": ${e.message}`); continue; }

    for (const child of data?.data?.children || []) {
      const p = child.data || {};
      const url = "https://www.reddit.com" + (p.permalink || "");
      if (!p.title || seen[url]) continue;
      const blob = `${p.title} ${(p.selftext || "").slice(0, 400)}`;
      if (GENERAL_SUBS.has(sub) && !DFW_PLACES.some((pl) => blob.toLowerCase().includes(pl))) continue;
      const [pts, hits] = score(blob);
      if (pts < 5) continue;
      seen[url] = 1;
      out.push({
        id: leadId(url, p.title),
        title: p.title,
        snippet: (p.selftext || "").replace(/\s+/g, " ").slice(0, 280),
        url,
        source: "Reddit",
        location: guessLocation(blob),
        posted: new Date((p.created_utc || Date.now() / 1000) * 1000).toISOString(),
        score: pts,
        matched: hits,
      });
    }
  }
  return out;
}

// --- craigslist -------------------------------------------------------------

const CL_SITES = ["dallas", "fortworth"];
const CL_SECTIONS = ["ggg", "lbg", "sks", "hss"];
const CL_QUERIES = ["retaining wall", "dirt work", "excavation", "grading",
  "dump truck", "haul off dirt", "land clearing", "fill dirt"];

async function scrapeCraigslist(seen, budget, log, combos) {
  const out = [];
  for (const [site, section, q] of combos) {
    if (!budget.ok(3000)) { log("craigslist: out of time"); break; }
    const url = `https://${site}.craigslist.org/search/${section}?query=${encodeURIComponent(q)}&format=rss`;
    let xml;
    try { xml = await get(url, { json: false }); }
    catch (e) { log(`cl ${site}/${section} "${q}": ${e.message}`); continue; }

    for (const item of xml.match(/<item[\s\S]*?<\/item>/g) || []) {
      const tag = (n) => {
        const m = item.match(new RegExp(`<${n}[^>]*>([\\s\\S]*?)</${n}>`));
        if (!m) return "";
        return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, "").trim();
      };
      const title = tag("title"), link = tag("link"), body = tag("description");
      if (!title || !link || seen[link]) continue;
      const [pts, hits] = score(`${title} ${body}`);
      if (pts < 4) continue;
      seen[link] = 1;
      out.push({
        id: leadId(link, title),
        title,
        snippet: body.slice(0, 280),
        url: link,
        source: "Craigslist",
        location: guessLocation(`${title} ${body}`),
        posted: tag("dc:date") || new Date().toISOString(),
        score: pts,
        matched: hits,
      });
    }
  }
  return out;
}

// --- shard helper -----------------------------------------------------------
// One run can't cover 500 searches in 30s, so each run takes a slice and the
// cursor advances. Over a few hours the whole surface gets covered.

function slice(list, cursor, n) {
  const out = [];
  for (let i = 0; i < n && i < list.length; i++) out.push(list[(cursor + i) % list.length]);
  return out;
}

function pairs(a, b) {
  const out = [];
  for (const x of a) for (const y of b) out.push([x, y]);
  return out;
}

function triples(a, b, c) {
  const out = [];
  for (const x of a) for (const y of b) for (const z of c) out.push([x, y, z]);
  return out;
}


const KEEP_DAYS = 60;
const MAX_LEADS = 400;

async function runScrape({ budgetMs = 22000 } = {}) {
  const budget = makeBudget(budgetMs);
  const log = [];
  const say = (m) => { log.push(m); console.log(m); };

  const store = getStore("dirt-ticket");

  const seen = (await store.get("seen", { type: "json" })) || {};
  const state = (await store.get("state", { type: "json" })) || { cursor: 0, datasets: null, dsCursor: 0 };
  const existing = (await store.get("leads", { type: "json" })) || [];

  // Permit datasets change rarely — discover once, reuse for a day.
  const dayOld = !state.datasetsAt || Date.now() - state.datasetsAt > 864e5;
  if (!state.datasets || dayOld) {
    state.datasets = await discoverDatasets(budget, say);
    state.datasetsAt = Date.now();
    say(`discovered ${state.datasets.length} permit dataset(s)`);
  }

  let fresh = [];

  // 1. Permits first — highest value per request. Two datasets per run.
  const ds = slice(state.datasets, state.dsCursor, 2);
  state.dsCursor = (state.dsCursor + 2) % Math.max(state.datasets.length, 1);
  fresh = fresh.concat(await scrapePermits(seen, budget, say, ds));

  // 2. Public bids — one request, always worth it.
  fresh = fresh.concat(await scrapeBids(seen, budget, say));

  // 3. Reddit and Craigslist, sharded so each run stays inside the budget.
  const rPairs = pairs(REDDIT_SUBS, REDDIT_QUERIES);
  const cCombos = triples(CL_SITES, CL_SECTIONS, CL_QUERIES);

  fresh = fresh.concat(await scrapeReddit(seen, budget, say, slice(rPairs, state.cursor * 4, 4)));
  fresh = fresh.concat(await scrapeCraigslist(seen, budget, say, slice(cCombos, state.cursor * 4, 4)));
  state.cursor = (state.cursor + 1) % 500;

  // merge, age out, cap
  const have = new Set(fresh.map((l) => l.id));
  const cutoff = Date.now() - KEEP_DAYS * 864e5;
  const beforeAge = fresh.length;
  const merged = [...fresh, ...existing.filter((l) => !have.has(l.id))]
    .filter((l) => {
      const t = Date.parse(l.posted);
      return isNaN(t) || t > cutoff;
    })
    .sort((a, b) => (b.score || 0) - (a.score || 0) || Date.parse(b.posted) - Date.parse(a.posted))
    .slice(0, MAX_LEADS);

  // keep the seen map from growing forever
  const seenKeys = Object.keys(seen);
  const trimmed = seenKeys.length > 6000
    ? Object.fromEntries(seenKeys.slice(-4000).map((k) => [k, 1]))
    : seen;

  await store.setJSON("leads", merged);
  await store.setJSON("seen", trimmed);
  await store.setJSON("state", state);
  await store.setJSON("meta", {
    generated: new Date().toISOString(),
    found: fresh.length,
    total: merged.length,
    ms: budget.used(),
    log,
  });

  const aged = beforeAge - merged.filter((l) => have.has(l.id)).length;
  if (aged > 0) say(`aged out ${aged} record(s) older than ${KEEP_DAYS} days`);
  say(`+${fresh.length} new, ${merged.length} total, ${budget.used()}ms`);
  return { found: fresh.length, total: merged.length, ms: budget.used(), log };
}


// ---------------------------------------------------------------- router

export { runScrape };

export default async (req) => {
  const path = new URL(req.url).pathname;

  // ---- /api/leads ----
  if (path.endsWith("/leads")) {
    try {
      const store = getStore("dirt-ticket");
      const [leads, meta] = await Promise.all([
        store.get("leads", { type: "json" }),
        store.get("meta", { type: "json" }),
      ]);
      if (!leads || !leads.length) {
        return Response.json({ leads: [], empty: true }, { headers: { "Cache-Control": "no-store" } });
      }
      return Response.json(
        { leads, generated: meta?.generated || null, found: meta?.found ?? null },
        { headers: { "Cache-Control": "no-store" } }
      );
    } catch (e) {
      return Response.json({ leads: [], error: String(e) }, { status: 500 });
    }
  }

  // ---- /api/scrape ----
  if (path.endsWith("/scrape")) {
    try {
      return Response.json(await runScrape({ budgetMs: 20000 }));
    } catch (e) {
      return Response.json({ error: String(e), stack: e.stack?.slice(0, 600) }, { status: 500 });
    }
  }

  // ---- /api/draft ----
  if (path.endsWith("/draft")) {
    if (req.method !== "POST") return new Response("POST only", { status: 405 });
    const env = (k) => globalThis.Netlify?.env?.get?.(k) ?? process.env[k];
    const key = env("ANTHROPIC_API_KEY");
  if (!key) {
    return Response.json(
      { error: "ANTHROPIC_API_KEY is not set on this site." },
      { status: 500 }
    );
  }

  let lead;
  try {
    lead = await req.json();
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }

    const company = env("COMPANY_NAME") || "[COMPANY]";
    const phone = env("COMPANY_PHONE") || "[PHONE]";
    const owner = env("OWNER_NAME") || "[NAME]";

  const system =
    `You write short outreach messages for a Dallas-Fort Worth contractor that builds ` +
    `segmental retaining walls and does excavation, grading, and dump-truck hauling. ` +
    `Sign as ${owner}, ${company}, ${phone}.\n\n` +
    `Rules:\n` +
    `- Under 90 words. Plain, direct, no marketing voice, no exclamation points.\n` +
    `- Reference the specific job in their post so it does not read as a template.\n` +
    `- Ask exactly one closing question that moves toward a site visit.\n` +
    `- Homeowner leads: offer a free look and a firm number.\n` +
    `- Contractor or permit leads: lead with truck capacity, insurance, and availability.\n` +
    `- Never invent prices, timelines, past projects, or credentials.\n` +
    `- Output only the message body. No preamble, no subject line, no quote marks.`;

  const prompt =
    `Source: ${lead.source || "unknown"}\n` +
    `Location: ${lead.location || "DFW"}\n` +
    (lead.contractor ? `Contractor named on permit: ${lead.contractor}\n` : "") +
    `Post title: ${lead.title || ""}\n` +
    `Post body: ${(lead.snippet || "").slice(0, 700)}`;

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        // Haiku is cheap and fast, which matters when you draft dozens a week.
        // Swap to claude-sonnet-5 if you want more polish per message.
        model: "claude-haiku-4-5-20251001",
        max_tokens: 400,
        system,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!r.ok) {
      const detail = await r.text();
      return Response.json(
        { error: `Anthropic API returned ${r.status}`, detail: detail.slice(0, 400) },
        { status: 502 }
      );
    }

    const data = await r.json();
    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    return Response.json({ message: text });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 502 });
    }
  }

  return new Response("Not found", { status: 404 });
};

export const config = { path: ["/api/leads", "/api/scrape", "/api/draft"] };
