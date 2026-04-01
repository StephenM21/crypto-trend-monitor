import "dotenv/config";
import axios from "axios";
import fs from "fs";
import path from "path";

/* =========================
   DISCORD WEBHOOKS
========================= */
const WEBHOOK_HOT    = process.env.DISCORD_WEBHOOK_URL_HOT;
const WEBHOOK_MOVING = process.env.DISCORD_WEBHOOK_URL_MOVING || process.env.DISCORD_WEBHOOK_URL_HOT;
const WEBHOOK_DEGEN  = process.env.DISCORD_WEBHOOK_URL_DEGEN;
const WEBHOOK_INTEL  = process.env.DISCORD_WEBHOOK_URL_INTEL;

if (!WEBHOOK_HOT)   throw new Error("Missing DISCORD_WEBHOOK_URL_HOT");
if (!WEBHOOK_DEGEN) throw new Error("Missing DISCORD_WEBHOOK_URL_DEGEN");
if (!WEBHOOK_INTEL) throw new Error("Missing DISCORD_WEBHOOK_URL_INTEL");

/* =========================
   TELEGRAM (multi-chat)
========================= */
const TELEGRAM_ENABLED  = String(process.env.TELEGRAM_ENABLED || "false").toLowerCase() === "true";
const TG_TOKEN          = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_IDS_RAW   = process.env.TELEGRAM_CHAT_IDS || process.env.TELEGRAM_CHAT_ID || "";
const TG_CHAT_IDS       = TG_CHAT_IDS_RAW.split(",").map((s) => s.trim()).filter(Boolean);

if (TELEGRAM_ENABLED) {
  if (!TG_TOKEN)           throw new Error("TELEGRAM_ENABLED=true but TELEGRAM_BOT_TOKEN missing");
  if (!TG_CHAT_IDS.length) throw new Error("TELEGRAM_ENABLED=true but TELEGRAM_CHAT_IDS missing");
}

/* =========================
   CONFIG
========================= */
const CHAINS               = (process.env.CHAINS || "solana,base").split(",").map((s) => s.trim()).filter(Boolean);
const POLL_SECONDS         = Number(process.env.POLL_SECONDS         || 15);
const PROFILES_PER_POLL    = Number(process.env.PROFILES_PER_POLL    || 0);   // 0 = all
const INTEL_POST_EVERY_MIN = Number(process.env.INTEL_POST_EVERY_MIN || 30);
const MAX_ALERTS_PER_TICK  = Number(process.env.MAX_ALERTS_PER_TICK  || 10);

const MIN_LIQ_USD            = Number(process.env.MIN_LIQ_USD            || 12000);
const MIN_VOL5M_USD          = Number(process.env.MIN_VOL5M_USD          || 4000);
const MIN_VOL5M_TO_LIQ_RATIO = Number(process.env.MIN_VOL5M_TO_LIQ_RATIO || 0.15);
const MAX_VOL5M_TO_LIQ_RATIO = Number(process.env.MAX_VOL5M_TO_LIQ_RATIO || 5);
const MIN_FDV_USD            = Number(process.env.MIN_FDV_USD            || 200_000);
const MAX_FDV_USD            = Number(process.env.MAX_FDV_USD            || 300_000_000);
const MIN_PRICE_CHANGE_5M    = Number(process.env.MIN_PRICE_CHANGE_5M    || 0);
const MIN_PRICE_CHANGE_1H    = Number(process.env.MIN_PRICE_CHANGE_1H    || 0);
const MIN_BUY_RATIO          = Number(process.env.MIN_BUY_RATIO          || 0.55);
const MIN_PAIR_AGE_MIN       = Number(process.env.MIN_PAIR_AGE_MIN       || 0);
const MAX_PAIR_AGE_MIN       = Number(process.env.MAX_PAIR_AGE_MIN       || 0);
const PAIR_DEDUPE_HOURS      = Number(process.env.PAIR_DEDUPE_HOURS      || 6);
const TOKEN_COOLDOWN_MIN     = Number(process.env.TOKEN_COOLDOWN_MIN     || 120);
const FETCH_CONCURRENCY      = Number(process.env.FETCH_CONCURRENCY      || 20);
const LOG_REJECTS            = String(process.env.LOG_REJECTS || "false").toLowerCase() === "true";

function parseListEnv(name, fallbackCsv) {
  const raw = process.env[name] ?? fallbackCsv;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

const DEX_ALLOWLIST_SOLANA   = parseListEnv("DEX_ALLOWLIST_SOLANA",   "raydium,orca,pumpfun,pumpswap").map((s) => s.toLowerCase());
const DEX_ALLOWLIST_BASE     = parseListEnv("DEX_ALLOWLIST_BASE",     "uniswap,aerodrome,sushiswap").map((s) => s.toLowerCase());
const QUOTE_ALLOWLIST_SOLANA = parseListEnv("QUOTE_ALLOWLIST_SOLANA", "SOL,USDC").map((s) => s.toUpperCase());
const QUOTE_ALLOWLIST_BASE   = parseListEnv("QUOTE_ALLOWLIST_BASE",   "WETH,ETH,USDC,USDT").map((s) => s.toUpperCase());

const http = axios.create({
  timeout: 20000,
  headers: { "User-Agent": "crypto-agent/v2" },
});

/* =========================
   ALERTS LOG FILE
========================= */
const ALERTS_FILE = path.join(process.cwd(), "alerts.json");

function writeAlertLog(chain, t, pair) {
  try {
    const entry = {
      ts:    Date.now(),
      tier:  t,
      chain,
      base:  pair?.baseToken?.symbol,
      quote: pair?.quoteToken?.symbol,
      liq:   Number(pair?.liquidity?.usd  || 0),
      vol:   Number(pair?.volume?.m5      || 0),
      buys:  Number(pair?.txns?.m5?.buys  || 0),
      sells: Number(pair?.txns?.m5?.sells || 0),
      pc5:   Number(pair?.priceChange?.m5 || 0),
      score: scoreAlert(pair),
      addr:  pair?.pairAddress,
      url:   pair?.url,
    };
    fs.appendFileSync(ALERTS_FILE, JSON.stringify(entry) + "\n");
  } catch (e) {
    console.error("alerts.json write error:", e?.message);
  }
}

/* =========================
   CONCURRENCY LIMITER
========================= */
function pLimit(concurrency) {
  const queue = [];
  let active = 0;
  const next = () => {
    if (active >= concurrency || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve).catch(reject).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

/* =========================
   PERSISTED DEDUPE STATE
========================= */
const STATE_FILE = path.join(process.cwd(), ".state.json");
let state = { pairs: {}, tokens: {} };
const now = () => Date.now();

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (e) { console.error("State load error:", e?.message); }
}

function pruneState() {
  const pairCutoff  = now() - PAIR_DEDUPE_HOURS  * 3_600_000;
  const tokenCutoff = now() - TOKEN_COOLDOWN_MIN * 60_000;
  let pruned = 0;
  for (const k of Object.keys(state.pairs))  { if (state.pairs[k]  < pairCutoff)  { delete state.pairs[k];  pruned++; } }
  for (const k of Object.keys(state.tokens)) { if (state.tokens[k] < tokenCutoff) { delete state.tokens[k]; pruned++; } }
  if (pruned) console.log(`[state] pruned ${pruned} stale entries`);
}

function saveState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8"); }
  catch (e) { console.error("State save error:", e?.message); }
}

function canAlert(chain, pairAddr, tokenAddr) {
  const lastPair = Number(state.pairs[`${chain}:${pairAddr}`]   || 0);
  const lastTok  = Number(state.tokens[`${chain}:${tokenAddr}`] || 0);
  return (
    now() - lastPair >= PAIR_DEDUPE_HOURS  * 3_600_000 &&
    now() - lastTok  >= TOKEN_COOLDOWN_MIN * 60_000
  );
}

function markAlert(chain, pairAddr, tokenAddr) {
  state.pairs[`${chain}:${pairAddr}`]   = now();
  state.tokens[`${chain}:${tokenAddr}`] = now();
  saveState();
}

/* =========================
   TELEGRAM
========================= */
async function sendTelegramToChat(chatId, text) {
  try {
    await http.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      chat_id: chatId, text, disable_web_page_preview: true,
    });
  } catch (e) {
    console.error(`Telegram FAILED → chat_id ${chatId}:`, e?.response?.status, e?.response?.data || e?.message);
  }
}

async function sendTelegram(text) {
  if (!TELEGRAM_ENABLED) return;
  await Promise.allSettled(TG_CHAT_IDS.map((id) => sendTelegramToChat(id, text)));
}

/* =========================
   DISCORD
========================= */
async function postDiscordEmbed(webhookUrl, embed) {
  await http.post(webhookUrl, { embeds: [embed] });
}

async function postDiscordText(webhookUrl, content) {
  await http.post(webhookUrl, { content, allowed_mentions: { parse: [] } });
}

/* =========================
   DEXSCREENER
========================= */
async function fetchProfiles() {
  const { data } = await http.get("https://api.dexscreener.com/token-profiles/latest/v1");
  return Array.isArray(data) ? data : [];
}

async function fetchPairs(chain, token) {
  const { data } = await http.get(`https://api.dexscreener.com/token-pairs/v1/${chain}/${token}`);
  return Array.isArray(data) ? data : [];
}

/* =========================
   INTEL WINDOW
========================= */
let windowStartedMs = now();

const intel = {
  dexCounts:     { solana: new Map(), base: new Map() },
  quoteCounts:   { solana: new Map(), base: new Map() },
  rejectReasons: { solana: new Map(), base: new Map() },
  alertsSent:    { HOT: 0, MOVING: 0, DEGEN: 0 },
  totalScanned:  0,
  totalPairs:    0,
};

function bump(map, key, amt = 1) {
  if (!map) return;
  const k = String(key || "").trim();
  if (!k) return;
  map.set(k, (map.get(k) || 0) + amt);
}

function topN(map, n = 6) {
  if (!map) return [];
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

function resetIntelWindow() {
  windowStartedMs       = now();
  intel.dexCounts       = { solana: new Map(), base: new Map() };
  intel.quoteCounts     = { solana: new Map(), base: new Map() };
  intel.rejectReasons   = { solana: new Map(), base: new Map() };
  intel.alertsSent      = { HOT: 0, MOVING: 0, DEGEN: 0 };
  intel.totalScanned    = 0;
  intel.totalPairs      = 0;
}

function recordReject(chain, reason) {
  bump(intel.rejectReasons?.[chain], reason);
}

/* =========================
   HELPERS
========================= */
function shortAddr(addr) {
  if (!addr || typeof addr !== "string") return "—";
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function fmtMoney(n) {
  const x = Number(n || 0);
  if (x >= 1e9) return `$${(x / 1e9).toFixed(2)}B`;
  if (x >= 1e6) return `$${(x / 1e6).toFixed(2)}M`;
  if (x >= 1e3) return `$${(x / 1e3).toFixed(1)}K`;
  return `$${x.toFixed(0)}`;
}

function fmtAge(createdAtMs) {
  if (!createdAtMs) return "unknown";
  const mins = Math.round((now() - createdAtMs) / 60000);
  if (mins < 60)   return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

function tier(pair) {
  const liq = Number(pair?.liquidity?.usd || 0);
  const vol = Number(pair?.volume?.m5     || 0);
  if (liq >= 40_000 && vol >= 15_000) return "HOT";
  if (liq >= 20_000 && vol >=  7_000) return "MOVING";
  return "DEGEN";
}

function tierColor(t) {
  if (t === "HOT")    return 0xFF4500;
  if (t === "MOVING") return 0xFFAA00;
  return 0x9B59B6;
}

function allowedDex(chain, dex) {
  const d = String(dex || "").toLowerCase();
  if (!d) return false;
  if (chain === "solana") return DEX_ALLOWLIST_SOLANA.includes(d);
  if (chain === "base")   return DEX_ALLOWLIST_BASE.includes(d);
  return false;
}

function allowedQuote(chain, quote) {
  const q = String(quote || "").toUpperCase();
  if (!q) return false;
  if (chain === "solana") return QUOTE_ALLOWLIST_SOLANA.includes(q);
  if (chain === "base")   return QUOTE_ALLOWLIST_BASE.includes(q);
  return false;
}

function passesQuality(chain, pair) {
  const liq     = Number(pair?.liquidity?.usd || 0);
  const vol     = Number(pair?.volume?.m5     || 0);
  const fdv     = Number(pair?.fdv            || 0);
  const tx5     = pair?.txns?.m5 || {};
  const buys    = Number(tx5?.buys  || 0);
  const sells   = Number(tx5?.sells || 0);
  const pc5     = Number(pair?.priceChange?.m5 || 0);
  const pc1h    = Number(pair?.priceChange?.h1 || 0);
  const ageMs   = pair?.pairCreatedAt ? now() - Number(pair.pairCreatedAt) : null;
  const ageMins = ageMs != null ? ageMs / 60_000 : null;

  if (liq < MIN_LIQ_USD)   return (recordReject(chain, "low_liq"),           false);
  if (vol < MIN_VOL5M_USD) return (recordReject(chain, "low_vol"),           false);
  if (!allowedDex(chain, pair?.dexId))
                            return (recordReject(chain, "dex_not_allowed"),   false);
  if (!allowedQuote(chain, pair?.quoteToken?.symbol))
                            return (recordReject(chain, "quote_not_allowed"), false);

  const ratio = liq > 0 ? vol / liq : 999;
  if (ratio < MIN_VOL5M_TO_LIQ_RATIO) return (recordReject(chain, "ratio_too_low"),    false);
  if (ratio > MAX_VOL5M_TO_LIQ_RATIO) return (recordReject(chain, "ratio_too_high"),   false);
  if (fdv > 0 && (fdv < MIN_FDV_USD || fdv > MAX_FDV_USD))
                                       return (recordReject(chain, "fdv_out_of_range"), false);

  if (MIN_PRICE_CHANGE_5M > 0 && pc5  < MIN_PRICE_CHANGE_5M) return (recordReject(chain, "weak_price_5m"), false);
  if (MIN_PRICE_CHANGE_1H > 0 && pc1h < MIN_PRICE_CHANGE_1H) return (recordReject(chain, "weak_price_1h"), false);

  const total = buys + sells;
  if (total > 0 && buys / total < MIN_BUY_RATIO) return (recordReject(chain, "weak_buy_pressure"), false);

  if (ageMins != null) {
    if (MIN_PAIR_AGE_MIN > 0 && ageMins < MIN_PAIR_AGE_MIN) return (recordReject(chain, "pair_too_new"), false);
    if (MAX_PAIR_AGE_MIN > 0 && ageMins > MAX_PAIR_AGE_MIN) return (recordReject(chain, "pair_too_old"), false);
  }

  return true;
}

function scoreAlert(pair) {
  const liq   = Number(pair?.liquidity?.usd || 0);
  const vol   = Number(pair?.volume?.m5     || 0);
  const tx5   = pair?.txns?.m5 || {};
  const buys  = Number(tx5?.buys  || 0);
  const sells = Number(tx5?.sells || 0);
  const pc5   = Number(pair?.priceChange?.m5 || 0);
  const total = buys + sells || 1;
  return (
    (vol / 1_000)        * 0.40 +
    (liq / 1_000)        * 0.20 +
    (buys / total * 100) * 0.25 +
    Math.min(pc5, 50)    * 0.15
  );
}

/* =========================
   EMBED BUILDERS
========================= */
function buildAlertEmbed(chain, pair) {
  const base  = pair?.baseToken  || {};
  const quote = pair?.quoteToken || {};
  const liq   = Number(pair?.liquidity?.usd || 0);
  const vol   = Number(pair?.volume?.m5     || 0);
  const fdv   = Number(pair?.fdv            || 0);
  const tx5   = pair?.txns?.m5 || {};
  const buys  = Number(tx5?.buys  || 0);
  const sells = Number(tx5?.sells || 0);
  const pc5   = Number(pair?.priceChange?.m5 || 0);
  const pc1h  = Number(pair?.priceChange?.h1 || 0);
  const pc6h  = Number(pair?.priceChange?.h6 || 0);
  const total = buys + sells || 1;
  const buyPct= Math.round(buys / total * 100);
  const ratio = liq > 0 ? (vol / liq).toFixed(2) : "—";
  const t     = tier(pair);
  const emoji = t === "HOT" ? "🔥" : t === "MOVING" ? "⚡" : "🧪";
  const pc5Str = pc5  >= 0 ? `+${pc5.toFixed(1)}%`  : `${pc5.toFixed(1)}%`;
  const pc1hStr= pc1h >= 0 ? `+${pc1h.toFixed(1)}%` : `${pc1h.toFixed(1)}%`;
  const pc6hStr= pc6h >= 0 ? `+${pc6h.toFixed(1)}%` : `${pc6h.toFixed(1)}%`;

  return {
    color: tierColor(t),
    title: `${emoji} ${t} — ${base.symbol || "??"}/${quote.symbol || "??"} on ${chain.toUpperCase()}`,
    url: pair.url,
    fields: [
      { name: "💧 Liquidity",        value: fmtMoney(liq),                        inline: true },
      { name: "📈 Vol (5m)",         value: fmtMoney(vol),                         inline: true },
      { name: "⚖️ Vol/Liq Ratio",   value: String(ratio),                         inline: true },
      { name: "🟢 Buys / 🔴 Sells", value: `${buys} / ${sells} (${buyPct}% buy)`, inline: true },
      { name: "💎 FDV",             value: fdv ? fmtMoney(fdv) : "unknown",        inline: true },
      { name: "🏦 DEX",             value: String(pair?.dexId || "—"),             inline: true },
      { name: "📊 Price Δ",         value: `5m: ${pc5Str}  1h: ${pc1hStr}  6h: ${pc6hStr}`, inline: false },
      { name: "🕒 Pair Age",        value: fmtAge(pair?.pairCreatedAt),            inline: true },
      { name: "🔗 Base Token",      value: `${base.symbol || "—"} \`${shortAddr(base.address)}\``, inline: true },
    ],
    footer: { text: `Pair dedupe ${PAIR_DEDUPE_HOURS}h • Token cooldown ${TOKEN_COOLDOWN_MIN}m • Score: ${scoreAlert(pair).toFixed(1)}` },
    timestamp: new Date().toISOString(),
  };
}

function buildIntelEmbed() {
  const mins = Math.max(1, Math.round((now() - windowStartedMs) / 60000));
  const fmt  = (entries) => entries.map(([k, v]) => `\`${k}\` **${v}**`).join("\n") || "—";
  return {
    color: 0x00BFFF,
    title: `📊 Agent Intel — last ~${mins}m`,
    fields: [
      { name: "Alerts sent", value: `🔥 HOT **${intel.alertsSent.HOT}** • ⚡ MOVING **${intel.alertsSent.MOVING}** • 🧪 DEGEN **${intel.alertsSent.DEGEN}**`, inline: false },
      { name: "📡 Scanned",                 value: `**${intel.totalScanned}** tokens → **${intel.totalPairs}** pairs`, inline: false },
      { name: "Solana — top dexIds",         value: fmt(topN(intel.dexCounts.solana,    6)), inline: true },
      { name: "Base — top dexIds",           value: fmt(topN(intel.dexCounts.base,      6)), inline: true },
      { name: "Solana — top quotes",         value: fmt(topN(intel.quoteCounts.solana,  6)), inline: true },
      { name: "Base — top quotes",           value: fmt(topN(intel.quoteCounts.base,    6)), inline: true },
      { name: "Solana — top reject reasons", value: fmt(topN(intel.rejectReasons.solana,8)), inline: true },
      { name: "Base — top reject reasons",   value: fmt(topN(intel.rejectReasons.base,  8)), inline: true },
    ],
    footer: { text: "Intel is posted to Discord only — Telegram stays clean." },
    timestamp: new Date().toISOString(),
  };
}

function buildIntelText() {
  const mins    = Math.max(1, Math.round((now() - windowStartedMs) / 60000));
  const solDex  = topN(intel.dexCounts.solana,    3).map(([k, v]) => `${k}:${v}`).join(" • ") || "—";
  const baseDex = topN(intel.dexCounts.base,      3).map(([k, v]) => `${k}:${v}`).join(" • ") || "—";
  const solRej  = topN(intel.rejectReasons.solana,3).map(([k, v]) => `${k}:${v}`).join(" • ") || "—";
  const baseRej = topN(intel.rejectReasons.base,  3).map(([k, v]) => `${k}:${v}`).join(" • ") || "—";
  return [
    `📊 Agent Intel Report (last ~${mins}m)`,
    `Scanned: ${intel.totalScanned} tokens / ${intel.totalPairs} pairs`,
    `Alerts: 🔥 HOT ${intel.alertsSent.HOT} • ⚡ MOVING ${intel.alertsSent.MOVING} • 🧪 DEGEN ${intel.alertsSent.DEGEN}`,
    `Sol dex: ${solDex}`,
    `Base dex: ${baseDex}`,
    `Sol rejects: ${solRej}`,
    `Base rejects: ${baseRej}`,
  ].join("\n");
}

/* =========================
   MAIN LOOP
========================= */
async function pollOnce() {
  let profiles = [];
  try {
    profiles = await fetchProfiles();
  } catch (e) {
    console.error("profiles fetch failed:", e?.response?.status, e?.message);
    return;
  }

  const relevant = profiles.filter((p) => CHAINS.includes(String(p.chainId)));
  const targets  = PROFILES_PER_POLL > 0 ? relevant.slice(0, PROFILES_PER_POLL) : relevant;

  intel.totalScanned += targets.length;

  const limit   = pLimit(FETCH_CONCURRENCY);
  const results = await Promise.allSettled(
    targets.map((p) =>
      limit(async () => {
        const chain = String(p.chainId);
        const token = p.tokenAddress;
        if (!token) return null;
        try {
          const pairs = await fetchPairs(chain, token);
          return { chain, token, pairs };
        } catch (e) {
          if (LOG_REJECTS) console.error("pairs fetch failed:", chain, e?.response?.status, e?.message);
          return null;
        }
      })
    )
  );

  const hits = [];

  for (const result of results) {
    if (result.status !== "fulfilled" || !result.value) continue;
    const { chain, pairs } = result.value;

    intel.totalPairs += pairs.length;

    for (const pair of pairs) {
      if (chain === "solana") {
        bump(intel.dexCounts.solana,   String(pair?.dexId || "unknown").toLowerCase());
        bump(intel.quoteCounts.solana, String(pair?.quoteToken?.symbol || "unknown").toUpperCase());
      } else if (chain === "base") {
        bump(intel.dexCounts.base,   String(pair?.dexId || "unknown").toLowerCase());
        bump(intel.quoteCounts.base, String(pair?.quoteToken?.symbol || "unknown").toUpperCase());
      }

      if (!passesQuality(chain, pair)) continue;

      const pairAddr = pair?.pairAddress;
      const baseAddr = pair?.baseToken?.address;
      if (!pairAddr || !baseAddr) continue;
      if (!canAlert(chain, pairAddr, baseAddr)) continue;

      hits.push({ chain, pair, pairAddr, baseAddr, score: scoreAlert(pair) });
    }
  }

  hits.sort((a, b) => b.score - a.score);

  let alertedThisTick = 0;

  for (const { chain, pair, pairAddr, baseAddr } of hits) {
    if (alertedThisTick >= MAX_ALERTS_PER_TICK) break;

    const t     = tier(pair);
    const embed = buildAlertEmbed(chain, pair);
    const hook  = t === "HOT" ? WEBHOOK_HOT : t === "MOVING" ? WEBHOOK_MOVING : WEBHOOK_DEGEN;

    try {
      await postDiscordEmbed(hook, embed);
      await sendTelegram(`${embed.title}\n${pair.url}`);
      markAlert(chain, pairAddr, baseAddr);
      writeAlertLog(chain, t, pair);  // ← writes to alerts.json

      intel.alertsSent[t] += 1;
      alertedThisTick++;

      console.log(`[${chain}] alerted ${t} (score ${scoreAlert(pair).toFixed(1)}):`, pair.url);
    } catch (e) {
      console.error("post failed:", e?.response?.status, e?.message);
    }
  }
}

async function postIntel() {
  try {
    await postDiscordEmbed(WEBHOOK_INTEL, buildIntelEmbed());
    console.log("Intel posted (embed).");
  } catch (e) {
    console.error("Intel embed failed:", e?.response?.status, e?.message);
    try {
      await postDiscordText(WEBHOOK_INTEL, buildIntelText());
      console.log("Intel posted (text fallback).");
    } catch (e2) {
      console.error("Intel text fallback failed:", e2?.response?.status, e2?.message);
    }
  } finally {
    resetIntelWindow();
  }
}

/* =========================
   STARTUP
========================= */
async function main() {
  loadState();
  pruneState();

  console.log("🚀 Crypto Agent v2 started:", {
    CHAINS,
    POLL_SECONDS,
    PROFILES_PER_POLL: PROFILES_PER_POLL || "ALL",
    INTEL_POST_EVERY_MIN,
    FETCH_CONCURRENCY,
    MAX_ALERTS_PER_TICK,
    TELEGRAM_ENABLED,
    MIN_BUY_RATIO,
    MIN_PRICE_CHANGE_5M,
  });

  await postDiscordText(WEBHOOK_INTEL, "✅ Crypto Agent v2 started — concurrent fetching, score-sorted alerts, buy pressure + momentum filters active.");

  if (TELEGRAM_ENABLED) {
    await sendTelegram(`✅ Crypto Agent v2 started.\nchat_ids: ${TG_CHAT_IDS.join(", ")}`);
  }

  await pollOnce();

  setTimeout(
    () => postIntel().catch((e) => console.error("intel first-run fatal:", e?.message)),
    2 * 60_000
  );

  setInterval(
    () => pollOnce().catch((e) => console.error("poll fatal:", e?.message)),
    POLL_SECONDS * 1000
  );

  setInterval(
    () => { pruneState(); postIntel().catch((e) => console.error("intel fatal:", e?.message)); },
    INTEL_POST_EVERY_MIN * 60_000
  );
}

main().catch((e) => {
  console.error("Fatal:", e?.message);
  process.exit(1);
});