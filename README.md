# Build your own Bluesky mirror bot 🦋

This is a template repo for building a [Bluesky](https://bsky.app/) bot that mirrors an X/Twitter account by pulling from existing
[sports mirror bots on Mastodon](sportsbots.xyz) as a workaround for lack of access to Twitter's API.

## Configuration

For local development, copy `.env.example` to `.env` and set the values. The app loads `.env` if it exists; environment
variables already set in the shell take precedence. Do not commit `.env`.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `BSKY_HANDLE` | Yes | — | Bluesky account handle used to log in and identify the account's feed. |
| `BSKY_PASSWORD` | Yes | — | Bluesky account password or app password. |
| `MASTODON_ACCESS_TOKEN` | Yes | — | Mastodon API token with read access to statuses. Keep this secret. |
| `MASTODON_HANDLE` | Yes | — | Mastodon account handle to replace with the Bluesky handle in mirrored post text, e.g. `@TEAM@sportsbots.xyz`. |
| `BSKY_SERVICE` | No | `https://bsky.social` | Bluesky service endpoint. |
| `POST_LIMIT` | No | `20` | Positive whole number of recent posts to fetch from Mastodon and check in the Bluesky feed. |

For GitHub Actions, add `BSKY_HANDLE`, `BSKY_PASSWORD`, and `MASTODON_ACCESS_TOKEN` under
**Settings > Secrets and variables > Actions > Secrets**. Add `MASTODON_HANDLE` under **Variables**. The workflow
currently uses the defaults for `BSKY_SERVICE` and `POST_LIMIT`; to override either in Actions, map it into the
workflow's `env` from a repository variable.

### Workflow schedule

The workflow's run frequency is configured by the `cron` expression in `.github/workflows/post.yml`. GitHub Actions can
delay scheduled runs, so execution may not happen exactly on the requested minute.

### [/.github/workflows/post.yml](.github/workflows/post.yml)

If the bot is slow to catch up, you can go to the Actions tab, select the most recent workflow (Post to Bluesky), and
re-run all jobs to push the bot to run again, if you so wish.

### [/ src / lib / bot.ts](src/lib/bot.ts)

#### 🔷 Line 29
`dryRun: true,`

**Purpose:** Toggle whether the bot is in test mode.

**What to change:** For the sake of organization, I included this step here, but **this should be done last** upon setup.
When you are ready for the bot to begin running, change `true` to `false`.

This can be toggled on and off (`false` or `true`, respectively) for any reason in the future, such as if you are
editing the code and want to avoid the possibility of the bot automatically running before you've fixed the bug or
changed whatever settings you're trying to update.

### [/ src / lib / getPostText.ts](src/lib/getPostText.ts)

#### 🔷 Line 28 (Optional)
`var nbcsphillyReg = new RegExp("@nbcsphilly", "g");`

**Purpose:** Tells the bot to look for this term/hashtag/handle/other text in the posts it pulls from Mastodon.

**What to change:** This is an example I left in for if you want the bot to change X/Twitter handles that it commonly
tags to the person's or organization's name. For example, I have these set up for all the players' usernames for the
Phillies and Flyers mirror bots. (See: [Phillies mirror bot code](https://github.com/AceOfBens/notphillies-bsky/blob/main/src/lib/getPostText.ts)
[Lines 27-53 and 120-146], [Flyers mirror bot code](https://github.com/AceOfBens/notflyers-bsky/blob/main/src/lib/getPostText.ts)
[Lines 25-60 and 123-156]).

In this specific example, I've replaced NBC Sports Philadelphia's X/Twitter handle with "NBCSP" because the Flyers will
tag the TV station (which is NBCSP for most games) and radio station where you can tune into the game at the beginning
of all 3 periods. In most cases, Bluesky users will still understand who is being referenced if a Twitter handle is left
in the post, but to ensure the text of the Bluesky posts remain accessible (especially since users can't click on the
tagged username and go to a profile to see what is tagged), I chose to create these text substitutions.

**To create your own**, the only two things you want to change from this example are:
`nbcsphillyReg` - This names the regex and connects it to the next step. It really doesn't matter what you name it, but
it helps you remember why you added it.
`@nbcsphilly` - You'll need to change the first term in the parentheses to whatever text you want replaced. Make sure
you keep quotation marks around this text.

#### 🔷 Line 89 (Optional, but necessary if you did the previous step)
`contentString = contentString.replace(nbcsphillyReg, "NBCSP");`

**Purpose:** Tells the bot what to replace the text from the source post with.

**What to change:** You'll need to replace both terms in the parentheses in the format of (exampleReg, "Text you wish
to replace whatever's in the source post"). Everything else in this line stays the same.

**Reminder!** If you haven't yet, go back to `/ src / lib / bot.ts`, Line 29 to
[toggle testing mode off](https://github.com/AceOfBens/sports-mirror-bot-bsky/blob/main/README.md#-line-29) so your bot
can run on Bluesky!
