import { spotify } from "./providers/spotify.js";
import { lastfm } from "./providers/lastfm.js";
import { getFact } from "./facts.js";

const providers = [spotify, lastfm];
const provider = providers[0]; // swap or add a picker later
const POLL_MS = 10000;

const $ = (id) => document.getElementById(id);
const seen = new Set();
let current = null;     // { artist, source }
let topArtists = [];
let following = true;   // true = switch artists automatically when the song changes
let busy = false;

function showError(msg) { $("error").textContent = msg; $("error").hidden = !msg; }

function renderFollowButton() { $("follow").hidden = following; }

async function showFact() {
  if (!current) return;
  showError("");
  $("artist").textContent = current.artist;
  $("source").textContent = current.source;
  $("fact").textContent = "Digging through the liner notes…";
  $("credit").textContent = "";
  const fact = await getFact(current.artist, { exclude: seen });
  if (!fact) {
    $("fact").textContent = `Couldn't find a reliable Wikipedia page for ${current.artist}. Try a different artist.`;
    return;
  }
  seen.add(fact.text);
  $("fact").textContent = fact.text;
  $("credit").innerHTML = fact.url
    ? `${fact.by} <a href="${fact.url}" target="_blank" rel="noopener">Wikipedia</a>`
    : "";
}

async function pickArtist({ preferNowPlaying }) {
  if (preferNowPlaying) {
    const np = await provider.getNowPlaying();
    if (np) { current = { artist: np.artist, source: `Now playing: ${np.track}` }; return; }
  }
  if (!topArtists.length) topArtists = await provider.getTopArtists();
  if (!topArtists.length) throw new Error("No listening history found yet. Play something and try again.");
  const others = topArtists.filter((a) => a !== current?.artist);
  current = { artist: others[Math.floor(Math.random() * others.length)], source: "From your top artists" };
}

// Runs every POLL_MS. When the playing artist changes, show a new fact.
async function poll() {
  if (!following || busy || document.hidden) return;
  busy = true;
  try {
    const np = await provider.getNowPlaying();
    if (!np) return;
    if (np.artist !== current?.artist) {
      current = { artist: np.artist, source: `Now playing: ${np.track}` };
      await showFact();
    } else if (!current.source.endsWith(np.track)) {
      current.source = `Now playing: ${np.track}`;   // same artist, new track
      $("source").textContent = current.source;
    }
  } catch (e) {
    showError(e.message);
  } finally {
    busy = false;
  }
}

async function start() {
  $("login").hidden = true;
  $("player").hidden = false;
  renderFollowButton();
  await pickArtist({ preferNowPlaying: true });
  await showFact();
  setInterval(poll, POLL_MS);
}

$("connect").onclick = () => provider.login().catch((e) => showError(e.message));
$("another").onclick = () => showFact().catch((e) => showError(e.message));
$("shuffle").onclick = () => {
  following = false;            // pause auto-switching while you browse
  renderFollowButton();
  pickArtist({ preferNowPlaying: false }).then(showFact).catch((e) => showError(e.message));
};
$("follow").onclick = () => {
  following = true;
  renderFollowButton();
  pickArtist({ preferNowPlaying: true }).then(showFact).catch((e) => showError(e.message));
};
$("logout").onclick = () => { provider.logout(); location.reload(); };

(async () => {
  try {
    await provider.handleRedirect();
    if (provider.isConnected()) await start();
    else $("login").hidden = false;
  } catch (e) {
    showError(e.message);
    $("login").hidden = provider.isConnected();
  }
})();
