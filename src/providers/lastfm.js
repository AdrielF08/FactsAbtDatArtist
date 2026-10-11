// Stub for a second listening service. Implement the same interface as spotify.js
// (Last.fm uses an API key + user.getRecentTracks / user.getTopArtists) and add it
// to the `providers` list in main.js.
export const lastfm = {
  id: "lastfm",
  name: "Last.fm",
  isConnected: () => false,
  async handleRedirect() { return false; },
  async login() { throw new Error("Last.fm isn't implemented yet."); },
  logout() {},
  async getNowPlaying() { return null; },
  async getTopArtists() { return []; },
};
