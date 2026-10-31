# Reverse Crafter (PoE 1): instructions for Claude

A static web app. You paste a Path of Exile 1 item and it shows how to craft it, step by step, with odds.
There is no build step and no npm dependencies: plain ES modules in `public/`.

## How to work in this repo
- Work through `ROADMAP.md` from top to bottom, one item at a time. Don't stop to ask questions unless you are truly blocked. If something is ambiguous, pick the most reasonable option, write the decision in `DECISIONS.md`, and keep going.
- After each roadmap item:
  1. Run all tests (see below). Every test must pass.
  2. Tick the item in `ROADMAP.md` and add one line of notes under it.
  3. Commit with a clear message and push.
- Keep the crafting engine (`public/js/engine/`) free of DOM code, so it runs in Node, the browser and the worker.
- Never put league-specific numbers in the code. Game data comes from `public/data/poe1.json`, which `tools/build_data.py` builds. Mechanics that RePoE doesn't export, such as Harvest crafts, go in hand-written JSON under `public/data/manual/`, with a source comment.
- If a probability depends on an assumption that isn't in the game data, put it in a named constant with a comment, and add it to the "Assumptions" list in the README.

## Commands
```bash
node test/run.mjs                       # parser on the sample items
node test/plan.mjs ring 0,3,5           # planner smoke test
node test/unit.mjs                      # unit tests (create this file if it doesn't exist and add tests for new code)
cd public && python3 -m http.server 8765 &
NODE_PATH=$(npm root -g) node test/browser.cjs boots   # end-to-end check in headless Chromium
```

Rebuild the game data:
```bash
git clone --depth 1 https://github.com/repoe-fork/repoe-fork.github.io /tmp/repoe
python3 tools/build_data.py /tmp/repoe/data public/data/poe1.json "$(cat /tmp/repoe/version.txt)"
```

## Hard rules
- The app only gives advice. It must never send input to the game, automate clicks or crafting, or read game memory. All of that is against GGG's Terms of Use.
- Keep the visible notice: "Not affiliated with or endorsed by Grinding Gear Games."
- poe.ninja: don't call it from users' browsers. Fetch prices on a schedule (a GitHub Action) into a static `public/data/prices.json`, send a descriptive User-Agent, and poll no more than once an hour.
