import assert from 'node:assert/strict';
import { test } from 'node:test';

import { config } from '../src/lib/config.ts';
import { getMastodonPosts } from '../src/lib/mastodon.ts';

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

test('returns normalized Mastodon post data', async () => {
  const [mastodonPost] = await getMastodonPosts(
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

  assert.deepEqual(mastodonPost, {
    postId: 'mastodon-1',
    text: 'Go Eagles & fly!',
    mediaAttachments: [],
  });
});

test('excludes reblogs and statuses with no content', async () => {
  const posts = await getMastodonPosts(
    mockMastodon([
      {
        id: 'mastodon-reblog',
        content: '<p>Reblogged content</p>',
        reblog: { id: 'original-post' },
        media_attachments: [],
      },
      {
        id: 'mastodon-empty',
        content: ' \n ',
        media_attachments: [],
      },
      {
        id: 'mastodon-content',
        content: '<p>Original post</p>',
        media_attachments: [],
      },
    ]),
    config.mastodonHandle,
  );

  assert.deepEqual(
    posts.map(({ postId }) => postId),
    ['mastodon-content'],
  );
});

test('applies Mastodon post text and card URL replacements', async () => {
  const [mastodonPost] = await getMastodonPosts(
    mockMastodon([
      {
        id: 'mastodon-replacements',
        content: `<p>@${config.mastodonHandle}&amp;&nbsp;@twitter.com@sportsbots.xyz https://old.com/story…</p><p>Second<br>line</p>`,
        media_attachments: [],
        card: {
          type: 'link',
          url: 'https://sports.test/story',
          title: 'Game recap',
          description: 'A short description',
        },
      },
    ]),
    config.mastodonHandle,
  );

  assert.equal(
    mastodonPost.text,
    '@eagles-bot.bsky.social& https://sports.test/story\n\nSecond\nline',
  );
});

test('returns media, video, and link-card metadata as structured fields', async () => {
  const [mastodonPost] = await getMastodonPosts(
    mockMastodon([
      {
        id: 'mastodon-media',
        content: '<p>Watch this highlight</p>',
        media_attachments: [
          {
            type: 'image',
            url: 'https://media.test/image.png',
            description: 'Players celebrating',
          },
          {
            type: 'video',
            url: 'https://media.test/highlights.mp4',
            preview_url: 'https://media.test/preview.png',
            meta: {
              original: { width: 1280, height: 720, duration: 120 },
            },
          },
        ],
        card: {
          type: 'photo',
          url: 'https://sports.test/story',
          title: 'Game recap',
          description: 'A short description',
          image: 'https://media.test/card.png',
        },
      },
    ]),
    config.mastodonHandle,
  );

  assert.deepEqual(mastodonPost, {
    postId: 'mastodon-media',
    text: 'Watch this highlight',
    mediaAttachments: [
      {
        url: 'https://media.test/image.png',
        altText: 'Players celebrating',
      },
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
    linkCard: {
      url: 'https://sports.test/story',
      title: 'Game recap',
      description: 'A short description',
      image: 'https://media.test/card.png',
    },
  });
});
