import assert from 'node:assert/strict';
import { test } from 'node:test';

import Bot from '../src/lib/bot.ts';
import { config } from '../src/lib/config.ts';
import { getMastodonPosts } from '../src/lib/mastodon.ts';

const emptyMedia = 'None!^&None!^&None!^&None';
const emptyAltText = 'None!^&None!^&None!^&None';

function feedEntry(text, uri = 'at://did:plc:feed/post', cid = 'feed-cid') {
  return {
    post: {
      uri,
      cid,
      record: { text },
    },
  };
}

function createBot({ feeds = [[]] } = {}) {
  const calls = {
    posts: [],
    uploads: [],
  };
  let feedIndex = 0;
  const agent = {
    app: {
      bsky: {
        feed: {
          getAuthorFeed: async () => {
            const feed = feeds[Math.min(feedIndex, feeds.length - 1)];
            feedIndex += 1;
            return { data: { feed } };
          },
        },
      },
    },
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
      return { uri: 'at://did:plc:bot/post', cid: 'posted-cid' };
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
      return { json: statuses };
    },
  };
}

test('converts a mocked Mastodon text response into the Bluesky post record', async () => {
  const serialized = await getMastodonPosts(
    mockMastodon([
      {
        id: 'mastodon-1',
        content: '<p>Go Eagles &amp; fly!</p>',
        media_attachments: [],
        card: null,
      },
    ]),
    config.mastodonHandle,
  );
  const [media, text, altText, linkCard] = serialized.split('~~~');
  const { bot, calls } = createBot();

  await withMockFetch(mockFetch(), async () => {
    await bot.post(false, media, altText, linkCard, text);
  });

  assert.equal(calls.posts.length, 1);
  assert.equal(calls.posts[0].text, 'Go Eagles & fly!');
  assert.equal('embed' in calls.posts[0], false);
});

test('uploads multiple images and preserves descriptions and missing alt text', async () => {
  const { bot, calls } = createBot();
  const media = [
    'https://media.test/one.png',
    'https://media.test/two.png',
    'None',
    'None',
  ].join('!^&');
  const alt = ['Crowd', 'None', 'None', 'None'].join('!^&');

  await withMockFetch(mockFetch(), async () => {
    await bot.post(false, media, alt, 'None', 'Image post');
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
      'https://media.test/large.png!^&None!^&None!^&None',
      'Large image!^&None!^&None!^&None',
      'None',
      'Text with oversized image',
    );
  });

  assert.equal(calls.posts.length, 1);
  assert.equal(calls.posts[0].text, 'Text with oversized image');
  assert.equal(calls.posts[0].embed, undefined);
});

test('uploads a link-card thumbnail and posts the external card embed', async () => {
  const { bot, calls } = createBot();
  const linkCard = [
    'https://sports.test/story',
    'Game recap',
    'A short description',
    'https://media.test/card.png',
  ].join('!^&');

  await withMockFetch(mockFetch(), async () => {
    await bot.post(
      false,
      emptyMedia,
      emptyAltText,
      linkCard,
      'Read this story',
    );
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
      'https://media.test/highlights.mp4!^&None!^&None!^&None',
      '1280@#*720@#*120@#*https://media.test/preview.png!^&None!^&None!^&None',
      'None',
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
      'https://media.test/highlights.mp4!^&None!^&None!^&None',
      '1280@#*720@#*120@#*https://media.test/preview.png!^&None!^&None!^&None',
      'None',
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
      'https://media.test/highlights.mp4!^&None!^&None!^&None',
      '1280@#*720@#*601@#*https://media.test/preview.png!^&None!^&None!^&None',
      'None',
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

test('attaches a reply to the latest feed post and retains the thread root', async () => {
  const root = feedEntry('Root post', 'at://did:plc:bot/root', 'root-cid');
  const reply = feedEntry('First reply', 'at://did:plc:bot/reply', 'reply-cid');
  const { bot, calls } = createBot({ feeds: [[root], [reply]] });

  await withMockFetch(mockFetch(), async () => {
    await bot.post(true, emptyMedia, emptyAltText, 'None', 'Second reply');
  });

  assert.deepEqual(calls.posts[0].reply, {
    root: { uri: 'at://did:plc:bot/root', cid: 'root-cid' },
    parent: { uri: 'at://did:plc:bot/root', cid: 'root-cid' },
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
  const { calls, agent } = createBot({
    feeds: [
      [],
      [feedEntry('First chunk', 'at://did:plc:bot/root', 'root-cid')],
      [feedEntry('Second chunk', 'at://did:plc:bot/reply', 'reply-cid')],
    ],
  });

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
    root: { uri: 'at://did:plc:bot/root', cid: 'root-cid' },
    parent: { uri: 'at://did:plc:bot/root', cid: 'root-cid' },
  });
  assert.deepEqual(calls.posts[2].reply, {
    root: { uri: 'at://did:plc:bot/root', cid: 'root-cid' },
    parent: { uri: 'at://did:plc:bot/reply', cid: 'reply-cid' },
  });
});

test('skips duplicate and empty posts without publishing to Bluesky', async () => {
  const { bot, calls } = createBot({
    feeds: [[feedEntry('Already mirrored')]],
  });

  await withMockFetch(mockFetch(), async () => {
    await bot.post(false, emptyMedia, emptyAltText, 'None', 'Already mirrored');
    await bot.post(false, emptyMedia, emptyAltText, 'None', '');
  });

  assert.equal(calls.posts.length, 0);
});

test('does not post a reply when the Bluesky feed has no parent post', async () => {
  const { bot, calls } = createBot({ feeds: [[]] });

  await withMockFetch(mockFetch(), async () => {
    await assert.rejects(
      bot.post(true, emptyMedia, emptyAltText, 'None', 'Reply without parent'),
      /Cannot create a reply because the Bluesky author feed has no posts/,
    );
  });

  assert.equal(calls.posts.length, 0);
});
