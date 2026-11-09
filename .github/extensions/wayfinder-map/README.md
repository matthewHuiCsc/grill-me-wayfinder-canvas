# Wayfinder Map canvas

Visualizes a `/wayfinder` map (from [mattpocock/skills](https://github.com/mattpocock/skills/tree/main/skills/engineering/wayfinder)) as a graph, with a ticket inspector and per-ticket session controls.

## Install

- **From a clone:** open the repository in Copilot to use the project extension. To use the same checkout across all your projects, run `./install.sh` from the repository root. It links the user extension to the checkout, leaves personal state in place, and refuses to overwrite different files. Keep the checkout in place.
- **From a gist:** use the Copilot app's **Install extension from gist** action and select user scope to make it available across projects.
- **From a GitHub repository:** install the extension folder URL, `https://github.com/<owner>/<repo>/tree/<branch>/.github/extensions/wayfinder-map`, at user or project scope.

Reload extensions or start a new session after installing or changing the code. Inside this repository, the project extension shadows the user extension with the same name; existing user-extension panels may need to be reopened.

## Share safely

From a checkout, use the app's **Share extension as gist** action and choose the **project**-scoped `wayfinder-map` extension. Alternatively, create a secret gist containing only the source files:

```sh
gh gist create --desc "Wayfinder Map" \
  .github/extensions/wayfinder-map/copilot-extension.json \
  .github/extensions/wayfinder-map/*.mjs \
  .github/extensions/wayfinder-map/ui.html \
  .github/extensions/wayfinder-map/README.md
```

Do not share the used **user**-scoped extension folder: its `artifacts/` directory contains personal map snapshots and session links. Those files are not part of the project extension or the source-only gist above.

## Opening it

| Tracker | `open_canvas` input |
| --- | --- |
| GitHub Issues | `{"source":"github","repo":"owner/name","map":42}` |
| Local Markdown | `{"source":"local","path":".scratch/<effort>"}` (or omit input if there is exactly one `.scratch/*/map.md`) |
| Anything else (Jira via Atlassian MCP, GitLab, …) | `{"source":"external","key":"jira:PROJ-123"}`, then the agent pushes the map with the `set_map` action |

GitHub and local maps are read directly (`gh` CLI / filesystem) and stay live: local maps reload on file changes; GitHub maps poll every two minutes and on **Refresh**. External maps are read by the agent using the project's **Wayfinding operations** (from `/setup-matt-pocock-skills`); **Refresh** asks the agent to re-read and re-push.

## What it shows

- **Top-down journey graph.** Start, decision branches, fog, and Destination frame the route. Solid arrows run from prerequisite to dependent ticket; dotted connectors are visual journey framing, not tracker dependencies. Resolved decisions can be hidden without changing tracker status.
- **Color indicates activity type:** red grilling, orange prototyping, purple research, neutral tasks. **Status changes a card's weight:** frontier cards are solid and full-color; blocked cards are dashed; resolved cards go quiet with a green check rail, a solid green *Resolved* badge, and green "travelled" arrows out of them.
- **Blue means "you are here" and nothing else.** Selection uses a neutral outline.
- **Status** follows Wayfinder's definitions: *frontier* (open, unblocked, unclaimed), *claimed* (assigned), *blocked*, *resolved*, *out of scope*. The first frontier ticket is marked **Next**.
- **Human involvement** is separate from status: **With you** means human in the loop (HITL), requiring live discussion; **Agent-led** means away from keyboard (AFK), requiring no live participation. Neither indicates whether a session is running. The legend and badge tooltips explain these terms.
- **Fog** (`Not yet specified`) sits before the destination: in scope, not yet ticketable. It is not represented as a fabricated ticket.
- **Out of scope** sits in its own lane, never on the route.
- The inspector shows the map's Destination, Notes, Decisions so far, and Legend, or a ticket's question, resolution, blockers, and linked session.

## Session controls (one ticket per session)

- Select a decision to inspect it and use its session controls. No sessions start automatically.
- **Map home.** The app nests a new session under the session that creates it, so ticket sessions are only started from the map's *home* session. That keeps them grouped flat under one parent, mirroring the tracker (map → child tickets); dependencies stay on the graph, which a session tree can't represent. The first non-ticket session to open a map becomes its home (stored in `artifacts/homes.json`); the overview can reassign it with **Make this session the home**. Elsewhere, frontier tickets offer **Go to map home to start**. The Start node shows the home session.
- **Start session** is enabled only for frontier tickets, from the map home, while tracker access is healthy. The canvas re-reads the tracker, invokes the app's native `create_session` tool with an interactive, one-ticket `/wayfinder` kickoff, and saves the returned session link. The new session rechecks eligibility and claims the ticket as its first write. Concurrent duplicate clicks in the same provider are rejected.
- **Open session** invokes the app's native `navigate_to` tool with the saved session ID. It works for historical/resolved tickets too.
- **Link existing session** lists actual app sessions and saves the selected session's ID. A tracker assignee is never guessed to be a session ID.
- **You are here.** When the panel is open in a session linked to a ticket, the header shows a **You are here** chip, the ticket gets a blue tab and ring, its prerequisite route from Start is drawn in blue, and it is selected and centered on load. New ticket sessions are asked to open the map so the marker shows there.
- **Unlink** forgets the association without deleting the session or altering the tracker claim.
- Native tool execution uses the runtime's normal permission pipeline. If the necessary app tools are unavailable, controls are disabled with an explanation rather than pretending a session was created or navigated to.

After updating the extension, reload it before using the new controls. An older running provider is detected and reports that a reload is needed.

## Design rules

- The tracker is the source of truth. The canvas never writes tickets, claims, or resolutions; it projects them.
- Session links and map homes are durable and keyed by map identity, not canvas instance. Personal data lives outside the checkout under `$COPILOT_HOME/extensions/wayfinder-map/artifacts/` (`~/.copilot/extensions/wayfinder-map/artifacts/` by default): `links.json`, `homes.json`, and `maps/` for agent-pushed snapshots.
- Tracker text is untrusted; prompts the canvas injects quote it as data.
- Unavailable tracker access shows an error (with the last known map, marked stale), never a silently empty map.
