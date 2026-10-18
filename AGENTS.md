# Repository instructions

This bot mirrors recent posts from a configured Mastodon account to a Bluesky account. It preserves supported media and link cards, splits long posts into threads, and can run in dry-run mode to report intended posts without publishing.

## Commands

- `npm ci` installs the lockfile dependencies.
- `npm run lint` runs Biome checks on `src/`.
- `npx tsc --noEmit` runs the strict TypeScript check; there is no separate build script.
- `npm start` runs the bot and can publish to Bluesky. Agents must always set `DRY_RUN=true` when testing changes to avoid publishing test posts.
- There is no configured test runner or test suite, so there is no single-test command.

## Architecture

- `src/index.ts` is the entry point and calls `Bot.run()`.
- `src/lib/config.ts` loads `.env` when present and validates all settings with Zod. Keep environment variable names and defaults aligned with `.env.example`, `README.md`, and `.github/workflows/post.yml`.
- `src/lib/mastodon.ts` exports the Mastodon API object, including `getPostText`, which looks up the configured account, fetches recent statuses, converts their HTML content to post text, and collects IDs, media, alt text, and link-card fields.
- `src/lib/bot.ts` parses that result, checks the Bluesky feed for duplicates, prepares image/video/link-card embeds, and publishes posts. Long Mastodon posts are split into a root post and replies; `DRY_RUN` logs intended actions instead of publishing.
- `.github/workflows/post.yml` runs the bot on a schedule using Node 24 and `npm ci`.

## Data and code conventions

- The data passed from `getPostText()` to `Bot.run()` is a positional string format: five fields (media URLs, post text, alt text, link cards, post IDs) joined by `~~~`; entries within each field use `@#%`; up to four attachment values within a post use `!^&`. Update both producer and consumer together if this format changes.
- Video metadata in an attachment alt-text field uses `@#*` to separate width, height, duration, and preview URL. Preserve that order wherever video metadata is parsed or produced.
- TypeScript runs directly in Node with ESM imports ending in `.ts`; follow the strict settings in `tsconfig.json`.
- Biome is the formatter and linter. Follow the repository's two-space indentation and single-quoted JavaScript strings.
- Keep configuration validation centralized in `src/lib/config.ts`; consumers should use the exported `config` object rather than reading environment variables independently.
