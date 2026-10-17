import { existsSync } from 'node:fs';
import { env, loadEnvFile } from 'node:process';
import { z } from 'zod';

if (existsSync('.env')) {
  loadEnvFile('.env');
}

const envSchema = z.object({
  BSKY_HANDLE: z.string().min(1),
  BSKY_PASSWORD: z.string().min(1),
  BSKY_SERVICE: z.string().min(1).default('https://bsky.social'),
  MASTODON_ACCESS_TOKEN: z.string().min(1),
  MASTODON_HANDLE: z.string().min(1),
  POST_LIMIT: z.coerce.number().int().positive().default(20),
});

const parsed = envSchema.parse(env);

export const config = {
  bskyHandle: parsed.BSKY_HANDLE,
  bskyPassword: parsed.BSKY_PASSWORD,
  bskyService: parsed.BSKY_SERVICE,
  mastodonAccessToken: parsed.MASTODON_ACCESS_TOKEN,
  mastodonHandle: parsed.MASTODON_HANDLE,
  postLimit: parsed.POST_LIMIT,
};
