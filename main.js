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

// Artist photo: shown as a small "polaroid" on the sleeve
function setImage(url) {
  if (url) $("photo").src = url; else $("photo").removeAttribute("src");
  $("photoWrap").hidden = !url;
}
$("photo").onerror = () => setImage(null);

// Album cover of the song that's playing, shown on the record's label
function setLabel(url) {
  const img = $("labelImg");
  if (url) img.src = url; else img.removeAttribute("src");
  img.hidden = !url;
  img.parentElement.classList.toggle("has-img", !!url);
}
$("labelImg").onerror = () => setLabel(null);

function renderFollowButton() { $("follow").hidden = following; }

async function showFact() {
  if (!current) return;
  showError("");
  $("artist").textContent = current.artist;
  $("source").textContent = current.source;
  setImage(current.image || null);
  setLabel(current.albumArt || null);
  $("album").textContent = current.album || "";
  $("fact").textContent = "Digging through the liner notes…";
  $("credit").textContent = "";
  const fact = await getFact(current.artist, { exclude: seen });
  if (!fact) {
    $("fact").textContent = `Couldn't find a reliable Wikipedia page for ${current.artist}. Try a different artist.`;
    return;
  }
  if (fact.image && !current.image) { current.image = fact.image; setImage(fact.image); } // Wikipedia photo as a fallback
  seen.add(fact.text);
  $("fact").textContent = fact.text;
  $("credit").innerHTML = fact.url
    ? `${fact.by} <a href="${fact.url}" target="_blank" rel="noopener">Wikipedia</a>`
    : "";
}

async function pickArtist({ preferNowPlaying }) {
  if (preferNowPlaying) {
    const np = await provider.getNowPlaying();
    if (np) { current = { artist: np.artist, source: `Now playing: ${np.track}`, image: np.image, albumArt: np.albumArt, album: np.album }; return; }
  }
  if (!topArtists.length) topArtists = await provider.getTopArtists();
  if (!topArtists.length) throw new Error("No listening history found yet. Play something and try again.");
  const others = topArtists.filter((a) => a !== current?.artist);
  const artist = others[Math.floor(Math.random() * others.length)];
  current = { artist, source: "From your top artists", image: provider.imageFor?.(artist) };
}

// Runs every POLL_MS. When the playing artist changes, show a new fact.
async function poll() {
  if (!following || busy || document.hidden) return;
  busy = true;
  try {
    const np = await provider.getNowPlaying();
    if (!np) return;
    if (np.artist !== current?.artist) {
      current = { artist: np.artist, source: `Now playing: ${np.track}`, image: np.image, albumArt: np.albumArt, album: np.album };
      await showFact();
    } else if (!current.source.endsWith(np.track)) {
      current.source = `Now playing: ${np.track}`;   // same artist, new track
      current.albumArt = np.albumArt;
      current.album = np.album;
      $("album").textContent = current.album || "";
      $("source").textContent = current.source;
      setLabel(current.albumArt || null);
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
