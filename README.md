# ESI Triage Kiosk (Proof of Concept)

AI triage kiosk using the Claude API. Live face mesh (MediaPipe), voice feature analysis, talking avatar, manual vitals, ESI v5 suggestion with nurse confirmation.

Not for clinical use. Simulated patients only.

## Setup on Netlify
1. Import this repo as a Netlify project (publish dir and functions are set in netlify.toml).
2. Add environment variable `ANTHROPIC_API_KEY` (mark as secret, scope Functions).
3. Optional: `CLAUDE_MODEL` (default `claude-sonnet-5-5`).
