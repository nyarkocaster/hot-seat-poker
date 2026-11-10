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
// open a page outside Discord (Discord asks the player to confirm)
export function openLink(url) {
  if (sdk && sdk.commands && sdk.commands.openExternalLink) return sdk.commands.openExternalLink({ url });
  window.open(url, "_blank", "noopener");
}
const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);
// onStep(text) shows what it's waiting for, so a stuck step is easy to spot
export async function startDiscord(onStep = () => {}) {
  onStep("Loading Discord's toolkit…");
  if (window.__hspDiscordMock) sdk = window.__hspDiscordMock; // tests
  else {
    // The SDK sends its first message to document.referrer. Coming from our own front page (which forwards
    // Discord to /play/), that's this site instead of Discord, and Discord never hears it. Use "any" then.
    try { if (document.referrer && new URL(document.referrer).origin === location.origin) Object.defineProperty(document, "referrer", { get: () => "", configurable: true }); } catch (e) {}
    const { DiscordSDK } = await import("./vendor/discord-sdk.js"); sdk = new DiscordSDK(DISCORD_ID);
  }
  onStep("Waiting for Discord to answer… (step 1 of 4)");
  await withTimeout(sdk.ready(), 20000, "Discord didn't answer the first handshake (step 1). Close the Activity and open it again.");
  onStep("Asking Discord to sign you in… If a Discord window asks to authorize Hot Seat Poker, press Authorize. (step 2 of 4)");
  let code;
  try { ({ code } = await withTimeout(sdk.commands.authorize({ client_id: DISCORD_ID, response_type: "code", state: "", prompt: "none", scope: ["identify"] }), 120000, "Discord didn't finish signing you in (step 2).")); }
  catch (e) { throw new Error(e && e.message ? (/step 2/.test(e.message) ? e.message : "Discord refused the sign-in (step 2): " + e.message) : "Discord refused the sign-in (step 2)."); }
  onStep("Signing in… (step 3 of 4)");
  const { access_token } = await withTimeout(post("/api/discord/token", { code }), 20000, "The site didn't answer the sign-in (step 3).");
  await withTimeout(sdk.commands.authenticate({ access_token }), 20000, "Discord didn't accept the sign-in (step 3).");
  onStep("Finding your table… (step 4 of 4)");
  return withTimeout(post("/api/discord/join", { access_token, instance: sdk.instanceId }), 20000, "The site didn't answer when looking for your table (step 4).");
}
