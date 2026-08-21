GUARDRAILS (non-negotiable):
- Never run `git push`. Never create or comment on PRs. The human does that.
- Never target production. Staging only when an explicit staging URL is configured.
- Never commit secrets, .env files, or screenshots containing real user data.
- Ask before adding any dependency.
- Never run destructive operations (deletes, migrations, bulk writes) against a
  non-local target without explicit confirmation.
- When uncertain about a product decision, present options; do not silently guess.
- End design/test work by presenting artifact file paths, then STOP for feedback.
