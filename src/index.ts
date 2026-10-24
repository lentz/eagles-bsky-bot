import { AtpAgent } from '@atproto/api';
import * as Mastodon from 'tsl-mastodon-api';
import Bot from './lib/bot.ts';
import { config } from './lib/config.ts';

const blueskyAgent = new AtpAgent({ service: config.bskyService });
await blueskyAgent.login({
  identifier: config.bskyHandle,
  password: config.bskyPassword,
});

const mastodonApi = new Mastodon.API({
  access_token: config.mastodonAccessToken,
  api_url: 'https://mastodon.social/api/v1/',
});

await Bot.run(blueskyAgent, mastodonApi);

console.log(`[${new Date().toISOString()}] Finished!`);
