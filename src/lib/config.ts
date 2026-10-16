import { existsSync } from 'node:fs';
import { env, loadEnvFile } from 'node:process';
import type { AtpAgentLoginOpts } from '@atproto/api';
import { z } from 'zod';

if (existsSync('.env')) {
  loadEnvFile('.env');
}

const envSchema = z.object({
  BSKY_HANDLE: z.string().min(1),
  BSKY_PASSWORD: z.string().min(1),
  BSKY_SERVICE: z.string().min(1).default('https://bsky.social'),
});

const parsed = envSchema.parse(env);

export const bskyAccount: AtpAgentLoginOpts = {
  identifier: parsed.BSKY_HANDLE,
  password: parsed.BSKY_PASSWORD,
};

export const bskyService = parsed.BSKY_SERVICE;
