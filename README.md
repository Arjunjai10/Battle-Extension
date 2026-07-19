# Showdown Battle Test Bot (Chrome extension)

Automates move/switch selection in your Pokemon Showdown battles, for
learning and bug-hunting in **unrated / room-match battles only**.

## Install (unpacked)

1. Go to `chrome://extensions`
2. Turn on "Developer mode" (top right)
3. Click "Load unpacked" and select this folder
4. Open https://play.pokemonshowdown.com and start an unrated battle
   (a direct challenge, or a match arranged in a room — not the ladder)
5. Click the extension icon → check "Auto-play enabled"

The bot will now click a move/switch automatically whenever the game is
waiting on your input.

## How it works

It watches the page for Showdown's move/switch buttons
(`button[name="chooseMove"]`, `button[name="chooseSwitch"]`,
`button[name="chooseTeamPreview"]`) and clicks one at random after a
short delay. This is intentionally a simple placeholder strategy —
you can edit the `evaluateAndAct()` function in `content.js` to add
your own decision logic once you're using it for a specific test.

## Important limits

- **It cannot tell ranked from unranked battles.** Toggle it off before
  laddering or any competitive play — leave it on only for battles you
  set up yourself to test or learn from.
- **Selectors may need adjusting.** I built this from Showdown's known
  button-naming convention but couldn't test it against the live
  client. If enabling it does nothing, open DevTools (F12) during a
  battle, right-click a move button → Inspect, and check its `name`
  or class attributes against `SELECTORS` at the top of `content.js`.

## Bug log

Every decision (and any error, with a full stack trace) is written to
a log you can view from the popup: click "Export bug log" to open it
in a new tab, then Ctrl+S / Cmd+S to save it as a `.txt` file to attach
to a bug report.
