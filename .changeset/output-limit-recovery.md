---
"@moonshot-ai/kimi-code": minor
---

Recover responses truncated by the output token limit instead of ending them immediately: partial output and thinking are preserved and continued up to three times (signed thinking resumes directly, other truncations get a continuation reminder); a turn that still truncates after the third recovery now fails with a provider error instead of completing as truncated.
