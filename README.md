# Rummy Room 🃏

Free Indian Rummy (13 cards, Points). Play offline against the computer, or with 2–6 friends. It runs on iPhone and Android as an installed app, has no ads and costs nothing. Players join with a room code.

## Put it online (one time, about 10 minutes, free)

Upload these files and the `icons` folder: `index.html`, `app.js`, `rules.js`, `turn.js`, `sw.js`, `manifest.webmanifest`, `README.md`. Don't upload the `.claude` folder. `index.html` must be at the top level, not inside another folder.

### Option A: Cloudflare Pages (recommended; the link doesn't show your name)

1. Make a free account at **dash.cloudflare.com**.
2. Go to **Workers & Pages** → **Create** → **Pages** → **Upload assets** (also called *Direct Upload*).
3. Choose a project name, for example `rummyroom-friends`. Your link will be **`https://rummyroom-friends.pages.dev`**.
4. Drag in the folder (or a zip of it), then click **Deploy site**.
5. To update later, open the project → **Create new deployment** → drag the folder in again.

### Option B: Netlify Drop (also neutral: `https://NAME.netlify.app`)

Go to **app.netlify.com/drop** and drag the folder in. Sign up (free) and *claim* the site within the hour, or it is deleted. Then change the site name to something neutral in the site settings. To update, drag the folder onto **Production deploys** again.

### Option C: GitHub Pages (shows your GitHub username in the link)

1. On **github.com** click **+** → **New repository**, name it `rummy`, choose **Public**, **Create repository**.
2. Click **uploading an existing file**, drag the files and the `icons` folder in, click **Commit changes**.
3. **Settings → Pages**: **Source: Deploy from a branch**, **Branch: main**, folder **/(root)**, **Save**.
4. After 1–2 minutes your link is **`https://YOUR-USERNAME.github.io/rummy/`**. (To hide your username, create a free GitHub *organization* with a neutral name and put the repo there: `https://ORGNAME.github.io/rummy/`.)

That link is your game. Send it to your friends.

**Private invite links:** the invite link looks like `https://your-site/#K7Q2M`. The room code sits after `#`, so it is never sent to the web host's server. The app also removes it from the address bar once you're in.

## Install it on phones

- **iPhone:** open the link in **Safari** → tap **Share** → **Add to Home Screen**.
- **Android:** open the link in **Chrome** → tap **⋮** → **Install app** (or *Add to Home screen*).

It then opens full-screen from its own icon, like a normal app.

## Play

The home screen has two options:

- **Play with AI:** offline, against 1–5 computer players. No internet needed after the first install. **Computer speed** (Quick / Normal / Slow) sets how long the computer thinks; you can also change it during a game from the ☰ menu.
- **Play with Friends:** one person taps **Create a room** and shares the 5-letter code or the invite link. Friends tap **Join**. The host starts each deal.

**Match length:** choose **Unlimited deals**, or **Fixed deals** (3 or more). In a fixed match the **1st and last deal score double points**. After the last deal, the lowest total wins the match. In Play with Friends the host sets this in the room before the first deal.

Your 13 cards arrive sorted by suit. Drag cards to arrange them, in any order inside a group or between groups, drag a card onto the **Open pile** to throw it, and drag a card onto **Finish** to declare. You can also tap cards and use the buttons. **Auto-arrange** finds a good grouping. On a computer, double-click a card to throw it.

## Fair play, like a real table

- The whole deck is shuffled **once per deal** with secure randomness. Its order never changes during the deal, and cards are dealt one at a time around the table.
- When the deck runs out, the open pile is **turned over (not shuffled)**, the way people do it at a real table.
- The computer only sees its own cards and the open pile. It never sees the deck or anyone else's hand, and it can't see the closed joker until it makes its own pure sequence.

## Rules used

- **3 decks with 2 printed jokers each** (162 cards). Each player gets 13 cards.
- **Closed joker:** one card is placed face-down under the deck. Each player sees it only after they arrange their first **pure sequence**. From then on, every card of that rank is a joker for that player. If the closed card is a printed joker, Aces are the jokers.
- **Pure sequence:** 3+ consecutive cards of one suit with no joker.
- **Pure group:** 3 identical cards, same number and same suit (e.g. 7♥ 7♥ 7♥), count as a **pure sequence**.
- **Impure group:** 2 identical cards plus a joker (e.g. 2♦ 2♦ joker) count as a **sequence with a joker**.
- **Sequence:** jokers may fill gaps. **Set:** 3–4 cards of the same number in different suits (e.g. 9♣ 9♦ 9♠).
- **Only one set per hand.** A second set is not valid: you can't declare with it, and its cards count as points.
- **To declare:** all 13 cards grouped, with at least 2 sequences, at least one of them pure.
- **Someone declared?** Everyone else gets time to group their cards and tap **Done**: 45 seconds with friends, no limit against the computer. Your points are counted from the groups you have when you tap Done or when time runs out.
- **Points:** A K Q J = 10, number cards = face value, jokers = 0. Only cards outside valid groups count. Losers score at least **1** and at most **80**. A loser without **2 sequences** (one pure, the second pure or impure) scores the full **80**. Wrong show = **80**. Drop before your first pick = 20, a later drop = 40. Lowest total wins.
- Printed jokers can't be picked from the open pile. You may throw back the card you just picked from it.

## Turn timer (Play with Friends)

Each turn has **45 seconds**. If time runs out, the player is marked **timed out** and the turn passes:
- If they had already picked a card, that card goes back onto the open pile.
- If they hadn't picked yet, the top card of the deck is turned onto the open pile.

Against the computer there's no timer. On Normal speed a computer turn takes about 3–6 seconds (Quick about 1.5–3, Slow about 5–9).

## Leaving and coming back

Anyone can leave (☰ → **Leave**) and come back to the ongoing game. Open **Play with Friends** and tap **Rejoin room**, or join with the same code, and you get your seat, cards and score back.

**When the host leaves, the game goes on.** One player is the **backup host** (marked in the room list). The backup's phone keeps a full copy of the game, just like the host's.
- **Host taps Leave:** the backup takes over at once, and everyone reconnects in a second or two with the same cards.
- **Host's app closes or the phone dies:** the others wait about 25 seconds in case it comes back, then the backup takes over.
- **Old host returns:** they join as a normal player.
- **Choosing the backup:** the backup is always someone with the app open on screen. If that player switches apps, another player becomes the backup.

To finish for good, the host uses **End room**, which sends everyone back to the home screen.

## Good to know

- If a phone sleeps or loses signal, reopen the app and it rejoins. If someone's gone on their turn, the host gets a **Drop them** button.
- Phones connect directly to each other, found through the free public PeerJS service. Short drops of that service no longer interrupt a game that is already running. The host checks every few seconds that each player is still there, so the ⚠ offline mark is accurate.
- A friend who can't get in sees why on the joining screen: *room not found* (wrong code, or the host's app is closed) or *can't reach the host's phone* (their network blocks direct connections). The second one needs a relay server, below.

## Friends stuck on "Joining room…"? Add a free relay server

Many mobile networks don't let two phones connect straight to each other. A **relay (TURN) server** passes the game messages between them instead. A card game sends very little data, so a free plan is enough.

1. Make a free account at **metered.ca**. When it asks you to **Create New App**, type any short name, e.g. `rummyroom123` (lowercase letters and numbers). It becomes `rummyroom123.metered.live`; players never see it.
2. In the dashboard go to **TURN Server → Credentials** and click **Create Credential**. Leave the region as it is. (Older dashboard: the **TURN Server** page → **Add Credential**.)
3. On that credential's row click **Get credential → Show API Key** and copy the key.
4. Build this address with your app name and key:
   `https://rummyroom123.metered.live/api/v1/turn/credentials?apiKey=YOUR-KEY`
   Open `turn.js`, paste it between the quotes on the `RUMMY_TURN_URL` line, and save.
5. Upload `turn.js` to your site again. A new credential can take about 2 minutes to start working.

Any other TURN provider works too: list its servers in `RUMMY_TURN` in the same file. The key ends up in a public file, which is normal for this kind of relay key. If it's ever misused, delete the credential and make a new one.

**Troubleshooting:** on a computer, open the browser console and type `rrNetLog()` to see the last connection steps.

## Testing on one computer

Private/InPrivate windows share one storage, so they would all be the same player. Add `?as=NAME` to the address to make each window a separate player, e.g. `https://your-site/?as=Asha` and `https://your-site/?as=Dev#K7Q2M`. Normal players never need this.

---

This is for fun only. It has no money, betting, ads or accounts.

## Files

`index.html` (styles), `app.js` (screens, drag & drop, animations, rooms), `rules.js` (rules + computer player), `turn.js` (relay server settings), `sw.js` + `manifest.webmanifest` (makes it installable), `icons/`.
