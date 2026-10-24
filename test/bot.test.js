import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import Bot from '../src/lib/bot.ts';
import { config } from '../src/lib/config.ts';

const emptyMedia = [];

function createBot() {
  const calls = {
    posts: [],
    uploads: [],
  };
  const agent = {
    login: async () => {},
    com: {
      atproto: {
        server: {
          getServiceAuth: async () => ({ data: { token: 'mock-token' } }),
        },
        repo: {
          uploadBlob: async (bytes, options) => {
            const blob = { ref: `blob-${calls.uploads.length + 1}` };
            calls.uploads.push({ bytes, options, blob });
            return { data: { blob } };
          },
        },
      },
    },
    post: async (record) => {
      calls.posts.push(record);
      const postNumber = calls.posts.length;
      return {
        uri: `at://did:plc:bot/post-${postNumber}`,
        cid: `posted-cid-${postNumber}`,
      };
    },
  };
  const bot = new Bot(agent);
  return { bot, calls, agent };
}

function mockResponse(bytes = Buffer.from('mock image')) {
  const buffer = Buffer.from(bytes);
  return {
    ok: true,
    arrayBuffer: async () =>
      buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength,
      ),
  };
}

async function withMockFetch(handler, callback) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options) => handler(String(input), options);
  try {
    await callback();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function mockFetch(
  canUploadVideo = true,
  mediaBytes = Buffer.from('mock image'),
) {
  return async (url) => {
    if (url === 'https://video.bsky.app/xrpc/app.bsky.video.getUploadLimits') {
      return {
        ok: true,
        json: async () => ({ canUpload: canUploadVideo }),
      };
    }
    return mockResponse(mediaBytes);
  };
}

function mockMastodon(statuses) {
  return {
    get: async (path, query) => {
      assert.equal(path, 'accounts/lookup');
      assert.equal(query.acct, config.mastodonHandle);
      return { status: 200, json: { id: 'mock-account-id' } };
    },
    getStatuses: async (accountId, options) => {
      assert.equal(accountId, 'mock-account-id');
      assert.equal(options.limit, 20);
      assert.equal(options.since_id, config.lastMastodonId || undefined);
      return { json: statuses };
    },
  };
}

test('uploads multiple images and preserves descriptions and missing alt text', async () => {
  const { bot, calls } = createBot();
  const media = [
    { url: 'https://media.test/one.png', altText: 'Crowd' },
    { url: 'https://media.test/two.png' },
  ];

  await withMockFetch(mockFetch(), async () => {
    await bot.post(false, media, undefined, 'Image post');
  });

  assert.equal(calls.uploads.length, 2);
  assert.deepEqual(calls.posts[0].embed.images, [
    { image: calls.uploads[0].blob, alt: 'Crowd' },
    { image: calls.uploads[1].blob, alt: '' },
  ]);
});

test('omits images larger than the one-megabyte upload limit but still posts text', async () => {
  const { bot, calls } = createBot();
  const oversizedImage = Buffer.alloc(1_000_001);

  await withMockFetch(mockFetch(true, oversizedImage), async () => {
    await bot.post(
      false,
      [{ url: 'https://media.test/large.png', altText: 'Large image' }],
      undefined,
      'Text with oversized image',
    );
  });

  assert.equal(calls.posts.length, 1);
  assert.equal(calls.posts[0].text, 'Text with oversized image');
  assert.equal(calls.posts[0].embed, undefined);
});

test('uploads a link-card thumbnail and posts the external card embed', async () => {
  const { bot, calls } = createBot();
  const linkCard = {
    url: 'https://sports.test/story',
    title: 'Game recap',
    description: 'A short description',
    image: 'https://media.test/card.png',
  };

  await withMockFetch(mockFetch(), async () => {
    await bot.post(false, emptyMedia, linkCard, 'Read this story');
  });

  assert.equal(calls.posts.length, 1);
  assert.deepEqual(calls.posts[0].embed, {
    $type: 'app.bsky.embed.external',
    external: {
      uri: 'https://sports.test/story',
      title: 'Game recap',
      description: 'A short description',
      thumb: calls.uploads[0].blob,
    },
  });
});

test('uploads an eligible video and posts its dimensions', async () => {
  const { bot, calls } = createBot();

  await withMockFetch(mockFetch(), async () => {
    await bot.post(
      false,
      [
        {
          url: 'https://media.test/highlights.mp4',
          video: {
            width: 1280,
            height: 720,
            duration: 120,
            previewUrl: 'https://media.test/preview.png',
          },
        },
      ],
      undefined,
      'Video post',
    );
  });

  assert.equal(calls.posts.length, 1);
  assert.deepEqual(calls.posts[0], {
    text: 'Video post',
    langs: ['en'],
    embed: {
      $type: 'app.bsky.embed.video',
      video: calls.uploads[0].blob,
      aspectRatio: { width: 1280, height: 720 },
    },
  });
});

test('uses a video thumbnail when daily Bluesky video uploads are unavailable', async () => {
  const { bot, calls } = createBot();

  await withMockFetch(mockFetch(false), async () => {
    await bot.post(
      false,
      [
        {
          url: 'https://media.test/highlights.mp4',
          video: {
            width: 1280,
            height: 720,
            duration: 120,
            previewUrl: 'https://media.test/preview.png',
          },
        },
      ],
      undefined,
      'Video fallback',
    );
  });

  assert.equal(calls.posts.length, 1);
  assert.deepEqual(calls.posts[0].embed.images, [
    {
      image: calls.uploads[0].blob,
      alt: 'The bot has posted its maximum number of videos for the day. This is the thumbnail of the video instead.',
    },
  ]);
});

test('uses a video thumbnail when the video is longer than Bluesky allows', async () => {
  const { bot, calls } = createBot();

  await withMockFetch(mockFetch(), async () => {
    await bot.post(
      false,
      [
        {
          url: 'https://media.test/highlights.mp4',
          video: {
            width: 1280,
            height: 720,
            duration: 601,
            previewUrl: 'https://media.test/preview.png',
          },
        },
      ],
      undefined,
      'Long video fallback',
    );
  });

  assert.equal(calls.posts.length, 1);
  assert.deepEqual(calls.posts[0].embed.images, [
    {
      image: calls.uploads[0].blob,
      alt: 'The video is too long to be posted on Bluesky. This is the thumbnail of the video instead.',
    },
  ]);
});

test('attaches a thread reply to the post created immediately before it', async () => {
  const { bot, calls } = createBot();

  await withMockFetch(mockFetch(), async () => {
    await bot.post(false, emptyMedia, undefined, 'Root post');
    await bot.post(true, emptyMedia, undefined, 'Reply to root');
  });

  assert.equal('reply' in calls.posts[0], false);
  assert.deepEqual(calls.posts[1].reply, {
    root: { uri: 'at://did:plc:bot/post-1', cid: 'posted-cid-1' },
    parent: { uri: 'at://did:plc:bot/post-1', cid: 'posted-cid-1' },
  });
});

test('splits long Mastodon posts into Bluesky thread records with reply references', async () => {
  const mastodon = mockMastodon([
    {
      id: 'long-post',
      content: `<p>${Array(100).fill('Eagles').join(' ')}</p>`,
      media_attachments: [],
      card: null,
    },
  ]);
  const { calls, agent } = createBot();

  await withMockFetch(mockFetch(), async () => {
    await Bot.run(agent, mastodon);
  });

  assert.equal(calls.posts.length, 3);
  assert.deepEqual(
    calls.posts.map(({ text }) => text.match(/\[\d\/\d\]$/)?.[0]),
    ['[1/3]', '[2/3]', '[3/3]'],
  );
  assert.ok(calls.posts.every(({ text }) => text.length <= 300));
  assert.equal('reply' in calls.posts[0], false);
  assert.deepEqual(calls.posts[1].reply, {
    root: { uri: 'at://did:plc:bot/post-1', cid: 'posted-cid-1' },
    parent: { uri: 'at://did:plc:bot/post-1', cid: 'posted-cid-1' },
  });
  assert.deepEqual(calls.posts[2].reply, {
    root: { uri: 'at://did:plc:bot/post-1', cid: 'posted-cid-1' },
    parent: { uri: 'at://did:plc:bot/post-2', cid: 'posted-cid-2' },
  });
});

test('links a Mastodon reply to its mirrored parent post', async () => {
  const mastodon = mockMastodon([
    {
      id: 'mastodon-reply',
      in_reply_to_id: 'mastodon-parent',
      content: '<p>Reply</p>',
      media_attachments: [],
      card: null,
    },
    {
      id: 'mastodon-parent',
      content: '<p>Parent</p>',
      media_attachments: [],
      card: null,
    },
  ]);
  const { calls, agent } = createBot();

  await withMockFetch(mockFetch(), async () => {
    await Bot.run(agent, mastodon);
  });

  assert.equal(calls.posts.length, 2);
  assert.equal('reply' in calls.posts[0], false);
  assert.deepEqual(calls.posts[1].reply, {
    root: { uri: 'at://did:plc:bot/post-1', cid: 'posted-cid-1' },
    parent: { uri: 'at://did:plc:bot/post-1', cid: 'posted-cid-1' },
  });
});

test('writes the last mirrored Mastodon ID to the GitHub step output', async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'eagles-bsky-bot-'));
  const outputPath = join(outputDirectory, 'github-output');
  const previousOutputPath = config.githubOutput;
  config.githubOutput = outputPath;
  const mastodon = mockMastodon([
    {
      id: 'mastodon-checkpoint',
      content: '<p>Checkpoint post</p>',
      media_attachments: [],
      card: null,
    },
  ]);
  const { agent } = createBot();

  try {
    await withMockFetch(mockFetch(), async () => {
      await Bot.run(agent, mastodon);
    });
    assert.equal(
      await readFile(outputPath, 'utf8'),
      'last_mastodon_id=mastodon-checkpoint\n',
    );
  } finally {
    config.githubOutput = previousOutputPath;
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test('publishes a Mastodon reply standalone when its parent was not mirrored', async () => {
  const mastodon = mockMastodon([
    {
      id: 'mastodon-reply',
      in_reply_to_id: 'unmirrored-parent',
      content: '<p>Reply</p>',
      media_attachments: [],
      card: null,
    },
  ]);
  const { agent, calls } = createBot();

  await withMockFetch(mockFetch(), async () => {
    await Bot.run(agent, mastodon);
  });

  assert.equal(calls.posts.length, 1);
  assert.equal('reply' in calls.posts[0], false);
});
