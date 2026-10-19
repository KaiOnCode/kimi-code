---
"@moonshot-ai/kimi-code": minor
---

Sessions in `kimi web` now unload from memory after 30 minutes idle and resume transparently on next access, instead of staying live indefinitely; set KIMI_CODE_SESSION_IDLE_RECLAIM_MS=0 to keep sessions live.
