# DC Solar KC App

Start every session by reading HANDOFF.md (current state, accounts, conventions) and PLAN.md (roadmap). The Expo app lives in `app/` — see `app/AGENTS.md` for Expo SDK 57 docs guidance. Database changes go in `supabase/migrations/` and are pasted into the Supabase SQL Editor by Devon (no CLI). Verify with `npx tsc --noEmit` + `npx expo export --platform web` (run inside `app/`) before any EAS build.
