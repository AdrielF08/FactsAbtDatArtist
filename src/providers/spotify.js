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
  if (!res.ok) throw new Error("Spotify sign-in failed. Try connecting again.");
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
    const token = await tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: sessionStorage.getItem("pkce_verifier"),
    });
    save(token);
    history.replaceState({}, "", REDIRECT_URI);
    return true;
  },

  logout: () => localStorage.removeItem(KEY),

  async getNowPlaying() {
    const data = await api("/me/player/currently-playing");
    if (!data?.item || data.currently_playing_type !== "track") return null;
    return { artist: data.item.artists[0].name, track: data.item.name };
  },

  async getTopArtists() {
    const data = await api("/me/top/artists?limit=30&time_range=medium_term");
    return data.items.map((a) => a.name);
  },
};
