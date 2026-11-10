// Hot Seat Poker as a Discord Activity: inside a voice channel, Discord opens the site with ?frame_id=...
// This signs the player in with Discord and finds the table for this Activity: whoever opened it
// teaches; everyone else in the call joins as a student, under their Discord name.
export const DISCORD_ID = "1569779005278658682";
export const inDiscord = () => new URLSearchParams(location.search).has("frame_id");

async function post(path, body) {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  let j = {}; try { j = await r.json(); } catch (e) {}
  if (!r.ok) throw new Error(j.error || "Something went wrong talking to the server.");
  return j;
}

let sdk = null;
export async function startDiscord() {
  if (window.__hspDiscordMock) sdk = window.__hspDiscordMock; // tests
  else { const { DiscordSDK } = await import("./vendor/discord-sdk.js"); sdk = new DiscordSDK(DISCORD_ID); }
  await sdk.ready();
  const { code } = await sdk.commands.authorize({ client_id: DISCORD_ID, response_type: "code", state: "", prompt: "none", scope: ["identify"] });
  const { access_token } = await post("/api/discord/token", { code });
  await sdk.commands.authenticate({ access_token });
  return post("/api/discord/join", { access_token, instance: sdk.instanceId });
}
