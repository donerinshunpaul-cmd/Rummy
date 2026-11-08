// Relay (TURN) servers for Play with Friends.
//
// Phones on mobile data often can't connect straight to each other. A relay server passes the game
// messages between them instead. Without one, some friends get stuck on "Joining room…".
// A card game sends very little data, so a free relay plan is plenty.
//
// Metered (free account at metered.ca):
//   1. Sign up. When it asks you to "Create New App", type any short name, e.g. rummyroom123
//      (lowercase letters and numbers). It becomes YOUR-APP.metered.live. Players never see it.
//   2. In the dashboard go to TURN Server -> Credentials (older dashboard: the TURN Server page)
//      and click "Create Credential" (older: "Add Credential"). Keep the default region.
//   3. On that credential's row click "Get credential" -> "Show API Key" (older: "Show API Key").
//   4. Put your app name and key into this address, paste it between the quotes below, and save:
//      https://YOUR-APP.metered.live/api/v1/turn/credentials?apiKey=YOUR-KEY
//   5. Upload this file to your site again. A new credential can take ~2 minutes to start working.
window.RUMMY_TURN_URL = 'https://rummyroom.metered.live/api/v1/turn/credentials?apiKey=15cb71929c65d8d305cf4a730c5e4d6e3418';

// Or list relay servers directly (any provider). With Metered you can click "ICE" on the credential's
// row (copies the ICE servers array) and paste its { ... } entries between the brackets below.
//   { urls: 'turn:relay.example.com:443?transport=tcp', username: 'name', credential: 'password' },
window.RUMMY_TURN = [
];
