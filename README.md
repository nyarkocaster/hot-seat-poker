# Hot Seat Poker

A live poker teaching table on its own website. Teachers create lobbies, set every card, stack and blind, and play for any seat. Students open the link, type a name, and take a seat. No Claude account is needed.

- Several lobbies run at once, each saved on the server.
- Co-teachers join a lobby with its teacher code. Each teacher sees the others' pointers, and an outline marks whatever another teacher is editing.
- **Reveal all cards** shows students every hand, folded ones included.
- Game options: antes (everyone or big blind ante), straddle (every hand or one hand), bomb pots, rake (percent, cap, no flop no drop), run it twice, and a shot clock.
- Dark theme by default, with a light mode button.
- Practice table that runs in the browser with no lobby.

It runs on Cloudflare's free plan.

## Putting it online (one time, about 15 minutes, no programming)

You need two free accounts: **GitHub** (stores the code) and **Cloudflare** (runs the site).

### 1. Put the code on GitHub
1. Sign up or sign in at https://github.com.
2. Click **+** (top right) → **New repository**. Name it `hot-seat-poker`, leave everything else as is, and click **Create repository**.
3. On the new page, click **uploading an existing file**.
4. Unzip `hot-seat-poker.zip` on your computer. Open the unzipped folder, select everything inside it (the `public`, `src` and `test` folders and the files next to them), and drag it all onto the GitHub page.
5. Click **Commit changes**.

(If you've connected GitHub to Claude, Claude can do this step for you instead. Just tell it the repository name.)

### 2. Deploy on Cloudflare
1. Sign up or sign in at https://dash.cloudflare.com (the free plan is fine; no card needed).
2. In the left menu open **Compute (Workers)** → **Workers & Pages**, then click **Create** (or **Create application**).
3. Choose **Import a repository** / **Connect to Git**, connect your GitHub account, and pick `hot-seat-poker`.
4. Leave the build settings as they are. The deploy command should be `npx wrangler deploy`. Click **Deploy**.
5. When it finishes, Cloudflare shows the site's address, something like `https://hot-seat-poker.<your-name>.workers.dev`. That's your site. Share it with students.

From then on, any change pushed to the GitHub repository goes live automatically.

### Optional: only let you start lobbies
By default anyone with the link can start a lobby (they only control their own). To require an organizer key:
Cloudflare → your `hot-seat-poker` Worker → **Settings** → **Variables and Secrets** → **Add** → type **Secret**, name `CREATE_KEY`, value any password you choose → **Deploy**. The home page then asks for that key when someone creates a lobby.

### Optional: your own domain
Cloudflare → your Worker → **Settings** → **Domains & Routes** → **Add** → **Custom domain**. This needs a domain you've added to Cloudflare.

## Using it
- **Start a lobby:** enter your name, a lobby name and a teacher code, then click **Create lobby**. Write the code down; you need it to teach in that lobby again. This browser remembers it too.
- **Co-teachers:** they open the site, click **Teach** on the lobby, and enter the teacher code.
- **Students:** they open the site (or the lobby link from the People tab), type a name, click **Join as student**, and tap an open seat. Each student's browser remembers them, so a reload keeps their seat.
- **Game options:** Table setup tab. "Straddle next hand" and "Bomb pot next hand" are in the action bar between hands.
- **Solver:** use the **Table / Side by side / Solver** switch at the top of a lobby. Once a hand reaches the flop with two players, the **Solver** panel under the action bar loads that street (board, pot, stacks, positions) into the solver, with ranges guessed from the preflop action. The solver is shared with the lobby: teachers and students edit the setup together, see each other's pointers, and move through the solved tree together (anyone can switch to **Explore on my own** and rejoin later). Only the computer that pressed **Solve** does the work; everyone else gets the results through the lobby. While **Follow the table** is on, cards and bets at the table move the solver along, and a teacher picking the next card in the solver sets it as the table's next card. Teachers choose when students may use it (Table setup → Teaching). The standalone page `/solver/` works too.
- **Big trees:** Quick and Standard trees run in the browser with nothing to install. Trees that need more than about 4 GB of memory run in the free **Hot Seat Solver app** (`/solver/app.html`), which runs on your computer and connects to the page.
- **Delete a lobby:** home page → **Teach** on the lobby → enter the code → **Delete this lobby…**

## Free plan limits
Cloudflare's free plan allows about 100,000 server requests a day. Messages are counted at roughly 20 to 1, and pointer movement is throttled, so a study group's evenings fit comfortably. If you ever hit the limit, the site pauses until the daily reset (midnight UTC) or you switch to the paid Workers plan.

## For developers
- `public/engine.js`: game engine (pure JS, shared by server and browser)
- `public/app.js`, `public/index.html`, `public/style.css`: the page
- `src/worker.js`: Cloudflare Worker with two Durable Objects. `Lobby` runs one table, talks WebSockets and keeps state in SQLite storage. `Directory` keeps the lobby list.
- `public/solver/core.js`: the solver component (shared state, engines, table sync), used by the table page and `public/solver/` (standalone page). `src/worker.js` relays shared-solver changes and node requests between lobby members.
- `solver-app/`: the Hot Seat Solver app, a small Rust program that runs the same solver natively and listens on `ws://127.0.0.1:47123` (only Hot Seat Poker pages may connect). `.github/workflows/solver-app.yml` builds it for Windows, Mac and Linux and publishes the zips on the `solver-app` release.
- `public/solver/`: the solver page. `solver/` holds the Rust wrapper around [postflop-solver](https://github.com/b-inary/postflop-solver) (Wataru Inariba, AGPL-3.0). The GitHub Action in `.github/workflows/solver.yml` compiles it to WebAssembly whenever `solver/` changes and commits the result to `public/solver/pkg-mt` (multi-threaded) and `public/solver/pkg-st` (single-threaded, used by Safari). `public/_headers` turns on the cross-origin isolation the threaded version needs.
- License: GNU AGPL v3 (see LICENSE), because the solver engine is AGPL. Anyone running a modified copy publicly must share their source.
- `npm install`, then `npm run dev` for a local server at http://localhost:8787, `npm test` for 300 random hands with chip-balance checks, and `npm run deploy` to deploy from your own machine.
