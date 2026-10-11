// Spotify provider: Authorization Code flow with PKCE (no backend, no client secret).
// Every provider exposes the same shape so other services can be swapped in:
//   id, name, isConnected(), handleRedirect(), login(), logout(),
//   getNowPlaying() -> { artist, track } | null
//   getTopArtists() -> string[]

import { SPOTIFY_CLIENT_ID, REDIRECT_URI } from "../config.js";

const AUTH_URL = "https://accounts.spotify.com/authorize";
const TOKEN_URL = "https://accounts.spotify.com/api/token";
const API = "https://api.spotify.com/v1";
const SCOPES = "user-read-currently-playing user-top-read";
const KEY = "spotify_auth";

// artist name -> photo url (filled from top artists + now-playing lookups)
const images = new Map();
// Spotify lists images largest first; a middle size is plenty for a small photo
const pickImage = (arr = []) => (arr[1] || arr[0])?.url || null;

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function pkcePair() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge };
}

const save = (t) => localStorage.setItem(KEY, JSON.stringify({ ...t, expires_at: Date.now() + t.expires_in * 1000 - 30000 }));
const load = () => JSON.parse(localStorage.getItem(KEY) || "null");

async function tokenRequest(params) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: SPOTIFY_CLIENT_ID, ...params }),
  });
  if (!res.ok) {
    // Show Spotify's actual reason (e.g. invalid_grant, invalid_client) so it's easy to debug
    const err = await res.json().catch(() => ({}));
    throw new Error(`Spotify sign-in failed: ${err.error_description || err.error || res.status}. Click Connect to try again.`);
  }
  return res.json();
}

async function accessToken() {
  let t = load();
  if (!t) throw new Error("Not connected.");
  if (Date.now() > t.expires_at) {
    const fresh = await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh_token });
    t = { refresh_token: t.refresh_token, ...fresh };
    save(t);
  }
  return t.access_token;
}

async function api(path) {
  const res = await fetch(API + path, { headers: { Authorization: `Bearer ${await accessToken()}` } });
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`Spotify request failed (${res.status}).`);
  return res.json();
}

export const spotify = {
  id: "spotify",
  name: "Spotify",

  isConnected: () => !!load(),

  async login() {
    const { verifier, challenge } = await pkcePair();
    sessionStorage.setItem("pkce_verifier", verifier);
    location.href = `${AUTH_URL}?${new URLSearchParams({
      client_id: SPOTIFY_CLIENT_ID,
      response_type: "code",
      redirect_uri: REDIRECT_URI,
      scope: SCOPES,
      code_challenge_method: "S256",
      code_challenge: challenge,
    })}`;
  },

  // Call on page load. Returns true if it just finished a login.
  async handleRedirect() {
    const code = new URLSearchParams(location.search).get("code");
    if (!code) return false;
    history.replaceState({}, "", REDIRECT_URI); // codes are single-use: never let a refresh resend this one
    const token = await tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: sessionStorage.getItem("pkce_verifier"),
    });
    save(token);
    return true;
  },

  logout: () => localStorage.removeItem(KEY),

  imageFor: (name) => images.get(name) || null,

  async getNowPlaying() {
    const data = await api("/me/player/currently-playing");
    if (!data?.item || data.currently_playing_type !== "track") return null;
    const artist = data.item.artists[0];
    let image = images.get(artist.name);
    if (!image) {
      try { image = pickImage((await api(`/artists/${artist.id}`))?.images); } catch { /* fall back to album art */ }
      if (image) images.set(artist.name, image);
    }
    const albumArt = pickImage(data.item.album?.images);
    const { name: albumName, release_date } = data.item.album || {};
    const album = albumName ? `${albumName}${release_date ? ` · ${release_date.slice(0, 4)}` : ""}` : "";
    return { artist: artist.name, track: data.item.name, image: image || albumArt, albumArt, album };
  },

  async getTopArtists() {
    const data = await api("/me/top/artists?limit=30&time_range=medium_term");
    data.items.forEach((a) => { const img = pickImage(a.images); if (img) images.set(a.name, img); });
    return data.items.map((a) => a.name);
  },
};
