// Fact source: Wikipedia text -> Claude (via the local server.py proxy) -> punchy facts.
// If Claude isn't available (no API key, error), falls back to plain Wikipedia sentences.
// Contract: getFact(artist, { exclude }) -> { text, url, by } | null

const cache = new Map(); // artist -> { sentences, extract, url, ai, rounds }
let aiDisabled = false;  // flips on if the server has no API key

// ---------- finding the RIGHT Wikipedia page ----------
const MUSIC = /\b(band|singer|rapper|musician|songwriter|record producer|producer|duo|group|dj|vocalist|composer|guitarist|pianist|drummer|artist)\b/i;
const NOT_ARTIST_TITLE = /\((album|song|EP|film|TV|soundtrack|single|mixtape|novel|video game|tour)[^)]*\)/i;
const norm = (s) =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").trim().replace(/^the /, "");
const titleBase = (t) => norm(t.replace(/\s*\([^)]*\)\s*$/, ""));

async function wiki(params) {
  const res = await fetch(`https://en.wikipedia.org/w/api.php?${new URLSearchParams({ action: "query", format: "json", origin: "*", ...params })}`);
  return Object.values((await res.json()).query?.pages || {});
}

async function findPage(artist) {
  const clean = artist.replace(/"/g, "");
  const common = {
    prop: "extracts|info|pageprops|pageimages", piprop: "thumbnail", pithumbsize: "500", exintro: "1", explaintext: "1", exlimit: "max",
    inprop: "url", ppprop: "disambiguation",
  };
  // Two sources: exact title guesses ("Taylor Swift", "Queen (band)") and a keyword search.
  const guesses = [clean, ...["singer", "band", "musician", "rapper", "group", "singer-songwriter"].map((t) => `${clean} (${t})`)];
  const [direct, searched] = await Promise.all([
    wiki({ ...common, redirects: "1", titles: guesses.join("|") }),
    wiki({ ...common, generator: "search", gsrsearch: `"${clean}" (musician OR band OR singer OR rapper)`, gsrlimit: "8" }),
  ]);

  const ids = new Set();
  const pages = [...direct, ...searched.sort((a, b) => a.index - b.index)]
    .filter((p) => p.pageid && !ids.has(p.pageid) && ids.add(p.pageid)); // drops missing + duplicate pages

  const want = norm(artist);
  let best = null, bestScore = 0;
  for (const p of pages) {
    if (p.pageprops && "disambiguation" in p.pageprops) continue;
    if (NOT_ARTIST_TITLE.test(p.title)) continue;
    const intro = p.extract || "";
    if (!MUSIC.test(intro)) continue;
    const score = titleBase(p.title) === want ? 3 : norm(intro.slice(0, 300)).includes(want) ? 2 : 0;
    if (score > bestScore) { best = p; bestScore = score; } // ties keep the earlier (exact-title) page
  }
  return best; // null when nothing trustworthy was found (better no fact than a wrong one)
}

async function loadArticle(artist) {
  if (cache.has(artist)) return cache.get(artist);
  const entry = { sentences: [], extract: "", url: "", image: "", ai: undefined, rounds: 0 };
  try {
    const page = await findPage(artist);
    if (page) {
      const [full] = await wiki({ pageids: String(page.pageid), prop: "extracts", explaintext: "1", exlimit: "1" });
      entry.url = page.fullurl;
      entry.image = page.thumbnail?.source || "";
      entry.extract = (full?.extract || "").split(/\n== (?:See also|References|Notes|External links|Further reading) ==/)[0];
      entry.sentences = entry.extract
        .split(/\n+/)
        .filter((line) => !line.startsWith("=") && line.length > 60)
        .flatMap((p) => p.match(/[^.!?]+[.!?]+(?=\s|$)/g) || [])
        .map((s) => s.trim())
        .filter((s) => s.length >= 50 && s.length <= 260 && /\d|first|only|named|born|formed|won|sold|inspired/i.test(s));
    }
  } catch (e) {
    console.warn("Wikipedia lookup failed:", e);
    return entry; // not cached, so it retries next time
  }
  cache.set(artist, entry);
  return entry;
}

// ---------- Claude ----------
// Returns unseen facts (array, maybe empty) or null if Claude is unavailable.
async function claudeFacts(artist, entry, exclude) {
  if (aiDisabled) return null;
  const unseen = () => (entry.ai || []).filter((f) => !exclude.has(f));
  if (unseen().length) return unseen();
  // Claude said the page isn't about this artist, or we've already asked 3 times
  if (entry.rounds >= 3 || (entry.rounds >= 1 && entry.ai.length === 0)) return unseen();

  try {
    const res = await fetch("/api/facts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ artist, extract: entry.extract, avoid: entry.ai || [] }),
    });
    if (res.status === 503 || res.status === 404) { aiDisabled = true; return null; }
    if (!res.ok) throw new Error(await res.text());
    const { facts } = await res.json();
    entry.rounds += 1;
    entry.ai = [...(entry.ai || []), ...facts];
    return unseen();
  } catch (e) {
    console.warn("Claude facts failed, using Wikipedia sentences:", e);
    return null;
  }
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

export async function getFact(artist, { exclude = new Set() } = {}) {
  const entry = await loadArticle(artist);
  if (!entry.extract) return null;

  const ai = await claudeFacts(artist, entry, exclude);
  if (ai === null) {
    // Claude unavailable: plain Wikipedia sentences
    const fresh = entry.sentences.filter((s) => !exclude.has(s));
    const pool = fresh.length ? fresh : entry.sentences;
    return pool.length ? { text: pick(pool), url: entry.url, image: entry.image, by: "From" } : null;
  }
  if (ai.length) return { text: pick(ai), url: entry.url, image: entry.image, by: "Written by Claude from" };
  if (entry.ai?.length) return { text: pick(entry.ai), url: entry.url, image: entry.image, by: "Written by Claude from" }; // seen them all: recycle
  return null; // Claude judged the page wasn't about this artist
}
