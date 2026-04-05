# Heartbeat-based sync redesign

## Overview

Replace all event-driven synchronization actions with a 1-second heartbeat timer that checks for sync work based on time-since-last-check.

## Mobile battery considerations

- iOS/Android will suspend the WebView when backgrounded, so the timer stops firing automatically — no explicit pause needed
- Use the Page Visibility API to pause the timer in the brief window before OS suspension
- Use adaptive backoff (1s → 5s → 30s) when ticks find nothing to do, reset on activity
- Keep the heartbeat tick cheap (dirty flag / timestamp guard) — avoid any network I/O unless there's actual work
- Real battery risk is radio wake from unnecessary network calls, not the timer itself

## Network polling optimization: peer-awareness

Google Drive push notifications require a relay server (not acceptable for a client-only plugin), so polling is the approach. To minimize unnecessary network traffic, clients should be aware of whether any peer is actively using the same sync folder:

- Each client writes a lightweight "presence" record to the sync folder (e.g., a small file or Drive app property) with a timestamp, updated periodically
- On each heartbeat tick, a client checks for recently-updated presence records from other clients
- **No peers active** → slow poll rate (e.g., 30s–60s); changes from another device are unlikely
- **Peer detected** → switch to fast poll rate (e.g., 5s–10s) to pick up changes promptly
- Presence record expires if not refreshed within a TTL (e.g., 2× the update interval); client reverts to slow poll when peers go stale

This avoids a relay server while still allowing near-real-time sync when multiple devices are actively in use. The presence check itself can piggyback on the normal `changes.list` poll (look for presence file changes) to avoid an extra network round-trip.
