# Eagles Bluesky mirror bot 🦋

[Bluesky](https://bsky.app/) bot that mirrors Eagles accounts on X/Twitter by pulling from existing
[sports mirror bots on Mastodon](sportsbots.xyz) and re-posts on Bluesky.

## Configuration

For local development, copy `.env.example` to `.env` and set the values. The app loads `.env` if it exists; environment
variables already set in the shell take precedence. Do not commit `.env`.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `BSKY_HANDLE` | Yes | — | Bluesky account handle used to log in and identify the account's feed. |
| `BSKY_PASSWORD` | Yes | — | Bluesky account password or app password. |
| `DRY_RUN` | No | `false` | When `true`, the bot logs a summary of posts it would publish or skip without publishing them. |
| `MASTODON_ACCESS_TOKEN` | Yes | — | Mastodon API token with read access to statuses. Keep this secret. |
| `MASTODON_HANDLE` | Yes | — | Mastodon account handle to replace with the Bluesky handle in mirrored post text, e.g. `@TEAM@sportsbots.xyz`. |
| `BSKY_SERVICE` | No | `https://bsky.social` | Bluesky service endpoint. |
| `POST_LIMIT` | No | `20` | Positive whole number of recent posts to fetch from Mastodon and check in the Bluesky feed. |

For GitHub Actions, add `BSKY_PASSWORD` and `MASTODON_ACCESS_TOKEN` under **Settings > Secrets and variables > Actions > Secrets**.
Add `BSKY_HANDLE` and `MASTODON_HANDLE` under **Variables**.

## Development

Run the unit tests with `npm test`. They use Node's built-in test runner and mocked Mastodon/Bluesky responses; no
service credentials or network access are needed.

## Workflow schedule

The workflow's run frequency is configured by the `cron` expression in `.github/workflows/post.yml`. GitHub Actions can
delay scheduled runs, so execution may not happen exactly on the requested minute.

If the bot is slow to catch up, you can go to the Actions tab, select the most recent workflow (Post to Bluesky), and
re-run all jobs to push the bot to run again, if you so wish.

## Content Replacements

The bot automatically replaces the configured `MASTODON_HANDLE` with `BSKY_HANDLE`. To add another substitution, edit
`src/lib/mastodon.ts`: define a regular expression and apply it to `contentString` with the replacement text.
For example, `/@nbcsphilly/g` can be replaced with `NBCSP`.
