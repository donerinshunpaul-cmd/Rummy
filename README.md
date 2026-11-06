# Rummy Room 🃏

Free Indian Rummy (13 cards, Points). Play offline against the computer, or with 2–6 friends. It runs on iPhone and Android as an installed app, has no ads and costs nothing. Players join with a room code.

## Put it online (one time, about 10 minutes, free)

You need a free GitHub account. Doing this on a computer is easiest.

1. Go to **github.com** and sign up (free).
2. Click **+** (top right) → **New repository**. Name it `rummy`, choose **Public**, and click **Create repository**.
3. On the new repo page, click **uploading an existing file**. Drag in **all the files and the `icons` folder** from this zip, then click **Commit changes**.
   - `index.html` must be at the top level, not inside another folder.
4. Go to **Settings → Pages**. Under *Build and deployment*, set **Source: Deploy from a branch**, **Branch: main**, folder **/(root)**, then click **Save**.
5. Wait 1–2 minutes and refresh the page. Your link will show up there:
   **`https://YOUR-USERNAME.github.io/rummy/`**

That link is your game. Send it to your friends.

(Other free hosts that also work: Cloudflare Pages or Netlify. Upload the same folder.)

## Install it on phones

- **iPhone:** open the link in **Safari** → tap **Share** → **Add to Home Screen**.
- **Android:** open the link in **Chrome** → tap **⋮** → **Install app** (or *Add to Home screen*).

It then opens full-screen from its own icon, like a normal app.

## Play

The home screen has two options:

- **Play with AI:** offline, against 1–5 computer players. No internet needed after the first install.
- **Play with Friends:** one person taps **Create a room** and shares the 5-letter code or the invite link. Friends tap **Join**. The host starts each deal.

**Match length:** choose **Unlimited deals**, or **Fixed deals** (3 or more). In a fixed match the **1st and last deal score double points**. After the last deal, the lowest total wins the match. In Play with Friends the host sets this in the room before the first deal.

**Your cards:** choose **Sort by suit**, or **As dealt · I arrange** to receive your 13 cards exactly as dealt and arrange them yourself. You can change this any time from the ☰ menu.

Drag cards to arrange them, in any order inside a group or between groups, drag a card onto the **Open pile** to throw it, and drag a card onto **Finish** to declare. You can also tap cards and use the buttons. **Auto-arrange** finds a good grouping. On a computer, double-click a card to throw it.

## Fair play, like a real table

- The whole deck is shuffled **once per deal** with secure randomness. Its order never changes during the deal, and cards are dealt one at a time around the table.
- When the deck runs out, the open pile is **turned over (not shuffled)**, the way people do it at a real table.
- The computer only sees its own cards and the open pile. It never sees the deck or anyone else's hand, and it can't see the closed joker until it makes its own pure sequence.

## Rules used

- **3 decks with 2 printed jokers each** (162 cards). Each player gets 13 cards.
- **Closed joker:** one card is placed face-down under the deck. Each player sees it only after they arrange their first **pure sequence**. From then on, every card of that rank is a joker for that player. If the closed card is a printed joker, Aces are the jokers.
- **Pure sequence:** 3+ consecutive cards of one suit with no joker.
- **Trio:** 3 identical cards (e.g. 7♥ 7♥ 7♥) count as a **pure sequence**. Only one trio counts per hand.
- **Sequence:** jokers may fill gaps. **Set:** 3–4 cards of one rank in different suits.
- **To declare:** all 13 cards grouped, with at least 2 sequences, at least one of them pure.
- **Points:** A K Q J = 10, number cards = face value, jokers = 0. Losers score at least **1** and at most **80**. A player with no pure sequence counts all cards. Wrong show = **80**. Drop before your first pick = 20, a later drop = 40. Lowest total wins.
- Printed jokers can't be picked from the open pile, and you can't throw back the card you just picked from it.

## Turn timer (Play with Friends)

Each turn has **45 seconds**. If time runs out, the player is marked **timed out** and the turn passes:
- If they had already picked a card, that card goes back onto the open pile.
- If they hadn't picked yet, the top card of the deck is turned onto the open pile.

Against the computer there's no timer. The computer never pauses more than about 4 seconds per turn.

## Leaving and coming back

Anyone can leave (☰ → **Leave**) and come back to the ongoing game. Open **Play with Friends** and join with the same room code, and you get your seat, cards and score back. This works for the host too, as long as the host comes back on the **same phone**, because the game is kept on the host's device. While the host is away the game pauses for everyone. To finish for good, the host uses **End room**.

## Good to know

- In Play with Friends, the room lives on the host's phone, so the host should keep the app open. If it closes, everyone pauses. When the host reopens the app, the room comes back with the same code and everyone reconnects.
- If a phone sleeps or loses signal, reopen the app and it rejoins. If someone's gone on their turn, the host gets a **Drop them** button.
- Phones connect directly to each other through the free public PeerJS service. If one friend can never connect, have them try Wi-Fi. A permanent fix is to add a free TURN server in `app.js` (the `ICE` line).
- This is for fun only. It has no money, betting, ads or accounts.

## Files

`index.html` (styles), `app.js` (screens, drag & drop, animations, rooms), `rules.js` (rules + computer player), `sw.js` + `manifest.webmanifest` (makes it installable), `icons/`.
