import type {
  $Typed,
  AppBskyEmbedExternal,
  AppBskyEmbedImages,
  AppBskyFeedPost,
  AtpAgentLoginOpts,
} from '@atproto/api';
import { AtpAgent, RichText } from '@atproto/api';

import { config } from './config.ts';
import getPostText from './getPostText.ts';

async function fetchBuffer(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch ${url}: ${response.status} ${response.statusText}`,
    );
  }
  return Buffer.from(await response.arrayBuffer());
}

function getFeedPostText(record: unknown): string | undefined {
  if (
    typeof record === 'object' &&
    record !== null &&
    'text' in record &&
    typeof record.text === 'string'
  ) {
    return record.text;
  }
  return undefined;
}

function isDuplicateOrEmpty(text: string, feedTexts: readonly string[]) {
  return text.length === 0 || feedTexts.includes(text);
}

export default class Bot {
  blueskyAgent: AtpAgent;

  public rootCid = '';
  public rootUri = '';

  constructor() {
    this.blueskyAgent = new AtpAgent({ service: config.bskyService });
  }

  /**
   * Authenticates the Bluesky agent.
   *
   * @param loginOpts - Credentials and options used to log in.
   */
  async login(handle: string, password: string) {
    await this.blueskyAgent.login({
      identifier: handle,
      password,
    });
  }

  /**
   * Retrieves recent text records from the configured Bluesky account.
   *
   * @returns Text from recent feed records that contain a string value.
   */
  async getRecentPostTexts() {
    const response = await this.blueskyAgent.app.bsky.feed.getAuthorFeed({
      actor: config.bskyHandle,
      limit: config.postLimit,
    });
    return response.data.feed
      .map(({ post }) => getFeedPostText(post.record))
      .filter((text): text is string => text !== undefined);
  }

  /**
   * Publishes a video post unless its text is empty or already in the recent feed.
   *
   * @param url - URL of the video to upload.
   * @param alt - Encoded video dimensions and thumbnail metadata.
   * @param text - Text or feed record to publish.
   * @returns A promise that resolves when the video is published or skipped.
   */
  async postVideo(
    url: string,
    alt: string,
    text:
      | string
      | (Partial<AppBskyFeedPost.Record> &
          Omit<AppBskyFeedPost.Record, 'createdAt'>),
  ): Promise<void> {
    const bskyFeedAwait = await this.blueskyAgent.app.bsky.feed.getAuthorFeed({
      actor: config.bskyHandle,
      limit: config.postLimit,
    });
    const bskyFeed = bskyFeedAwait.data.feed;
    const feedTexts = bskyFeed
      .map(({ post }) => getFeedPostText(post.record))
      .filter((feedText): feedText is string => feedText !== undefined);

    if (typeof text === 'string' && isDuplicateOrEmpty(text, feedTexts)) {
      console.log(`Post has already been mirrored.`);
      return;
    } else if (typeof text !== 'string') {
      return;
    }

    const metadataArr = alt.split('@#*');

    const videoBuffer = await fetchBuffer(url);

    const { data } = await this.blueskyAgent.com.atproto.repo.uploadBlob(
      new Uint8Array(videoBuffer),
    );

    if (!data?.blob) {
      throw new Error('Failed to upload video: no blob returned.');
    }

    console.log('Video uploaded, posting...');

    await this.blueskyAgent.post({
      text: text,
      langs: ['en'],
      embed: {
        $type: 'app.bsky.embed.video',
        video: data.blob,
        aspectRatio: {
          width: parseInt(metadataArr[0], 10),
          height: parseInt(metadataArr[1], 10),
        },
      },
    });
  }

  /**
   * Publishes a post or reply with any available media or link-card embeds.
   *
   * @param isReply - Whether the post should reply to the preceding thread post.
   * @param url - Encoded media URLs associated with the source post.
   * @param alt - Encoded media descriptions and video metadata.
   * @param card - Encoded link-card metadata, or `None` when no card exists.
   * @param text - Text or feed record to publish.
   * @returns The Bluesky post response, or `37` when the post is skipped.
   */
  async post(
    isReply: boolean,
    url: string,
    alt: string,
    card: string,
    text:
      | string
      | (Partial<AppBskyFeedPost.Record> &
          Omit<AppBskyFeedPost.Record, 'createdAt'>),
  ) {
    let img: $Typed<AppBskyEmbedImages.Main> | undefined;
    const urls = url.split('!^&');
    const alts = alt.split('!^&');
    const cards = card.split('!^&');
    let cardEmbed: $Typed<AppBskyEmbedExternal.Main> | undefined;

    const { data: serviceAuth } =
      await this.blueskyAgent.com.atproto.server.getServiceAuth({
        aud: 'did:web:video.bsky.app',
        lxm: 'app.bsky.video.getUploadLimits',
        exp: Date.now() / 1000 + 60 * 30,
      });
    const token = serviceAuth.token;
    const limitsUrl =
      'https://video.bsky.app/xrpc/app.bsky.video.getUploadLimits';
    const limitsResponse = await fetch(limitsUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!limitsResponse.ok) {
      throw new Error(
        `Failed to fetch video upload limits: ${limitsResponse.status} ${limitsResponse.statusText}`,
      );
    }
    const limits = await limitsResponse.json();

    if (
      urls[0].slice(-3) === 'mp4' &&
      parseFloat(alts[0].split('@#*')[2]) <= 600 &&
      limits.canUpload === true
    ) {
      await this.postVideo(urls[0], alts[0], text);
      return 37;
    } else {
      if (urls[0].slice(-3) === 'mp4') {
        urls[0] = alts[0].split('@#*')[3];
        if (limits.canUpload === false) {
          alts[0] =
            'The bot has posted its maximum number of videos for the day. This is the thumbnail of the video instead.';
        } else {
          alts[0] =
            'The video is too long to be posted on Bluesky. This is the thumbnail of the video instead.';
        }
      }
      if (card !== 'None' && urls[0] === 'None') {
        const cardBuffer = await fetchBuffer(cards[3]);
        const cardUpload = await this.blueskyAgent.com.atproto.repo.uploadBlob(
          new Uint8Array(cardBuffer),
          { encoding: 'image/png' },
        );
        const cardObj = {
          uri: cards[0],
          title: cards[1],
          description: cards[2],
          thumb: cardUpload.data.blob,
        };
        cardEmbed = { $type: 'app.bsky.embed.external', external: cardObj };
      }

      for (let i = 0; i < 4; i++) {
        if (urls[i] !== 'None') {
          const buffer = await fetchBuffer(urls[i]);
          if (buffer.length <= 1000000) {
            const upload = await this.blueskyAgent.com.atproto.repo.uploadBlob(
              new Uint8Array(buffer),
              { encoding: 'image/png' },
            );
            if (img === undefined) {
              if (alts[i] !== 'None') {
                img = {
                  images: [{ image: upload.data.blob, alt: alts[i] }],
                  $type: 'app.bsky.embed.images',
                };
              } else {
                img = {
                  images: [{ image: upload.data.blob, alt: '' }],
                  $type: 'app.bsky.embed.images',
                };
              }
            } else {
              if (alts[i] !== 'None') {
                img.images.push({
                  image: upload.data.blob,
                  alt: alts[i],
                });
              } else {
                img.images.push({ image: upload.data.blob, alt: '' });
              }
            }
          }
        }
      }

      const bskyFeedAwait = await this.blueskyAgent.app.bsky.feed.getAuthorFeed(
        {
          actor: config.bskyHandle,
          limit: config.postLimit,
        },
      );
      const bskyFeed = bskyFeedAwait.data.feed;
      let parentId = { uri: '', cid: '' };
      if (isReply === false) {
        this.rootUri = '';
        this.rootCid = '';
      } else {
        const bskyPost0 = bskyFeed[0]?.post;
        if (!bskyPost0) {
          throw new Error(
            'Cannot create a reply because the Bluesky author feed has no posts.',
          );
        }
        const bskyUri = bskyPost0.uri;
        const bskyCid = bskyPost0.cid;
        parentId = { uri: bskyUri, cid: bskyCid };
        if (this.rootUri === '') {
          this.rootUri = bskyUri;
          this.rootCid = bskyCid;
        }
      }
      const feedTexts = bskyFeed
        .map(({ post }) => getFeedPostText(post.record))
        .filter((feedText): feedText is string => feedText !== undefined);
      if (typeof text === 'string' && isDuplicateOrEmpty(text, feedTexts)) {
        console.log('Post has already been mirrored.');
        return '37';
      }
      if (typeof text === 'string') {
        const richText = new RichText({ text });
        await richText.detectFacets(this.blueskyAgent);
        let record: Partial<AppBskyFeedPost.Record> &
          Omit<AppBskyFeedPost.Record, 'createdAt'>;
        if (isReply === true) {
          const rootId = { uri: this.rootUri, cid: this.rootCid };
          if (urls[0] !== 'None') {
            record = {
              text: richText.text,
              facets: richText.facets,
              reply: { root: rootId, parent: parentId },
              embed: img,
            };
          } else if (card !== 'None') {
            record = {
              text: richText.text,
              facets: richText.facets,
              reply: { root: rootId, parent: parentId },
              embed: cardEmbed,
            };
            console.log('record with card');
            console.log(record);
          } else {
            record = {
              text: richText.text,
              facets: richText.facets,
              reply: { root: rootId, parent: parentId },
            };
          }
        } else {
          if (urls[0] !== 'None') {
            console.log('there is a url.');
            record = {
              text: richText.text,
              facets: richText.facets,
              embed: img,
            };
          } else if (card !== 'None') {
            console.log('there is a card.');
            record = {
              text: richText.text,
              facets: richText.facets,
              embed: cardEmbed,
            };
            console.log('record with card');
            console.log(record);
          } else {
            console.log('no url or card');
            record = {
              text: richText.text,
              facets: richText.facets,
            };
          }
        }
        return this.blueskyAgent.post(record);
      } else {
        return this.blueskyAgent.post(text);
      }
    }
  }

  /**
   * Mirrors recent Mastodon posts to Bluesky, splitting long posts into threads.
   *
   * @returns A promise that resolves when mirroring is complete.
   */
  static async run() {
    const bot = new Bot();
    await bot.login(config.bskyHandle, config.bskyPassword);
    const dryRunFeedTexts = config.dryRun
      ? await bot.getRecentPostTexts()
      : undefined;
    const mastodonAwait = await getPostText();

    const urlsStringsAltsCardsArr = mastodonAwait.split('~~~');
    const mastUrlArr = urlsStringsAltsCardsArr[0].split('@#%');
    const mastodonArr = urlsStringsAltsCardsArr[1].split('@#%');
    const mastAltArr = urlsStringsAltsCardsArr[2].split('@#%');
    const mastCardArr = urlsStringsAltsCardsArr[3].split('@#%');
    const mastIdArr = urlsStringsAltsCardsArr[4].split('@#%');

    const logDryRunPost = (postId: string, isReply: boolean, text: string) => {
      if (dryRunFeedTexts && isDuplicateOrEmpty(text, dryRunFeedTexts)) {
        console.log(`[DRY RUN] Post ${postId} has already been mirrored.`);
        return;
      }
      console.log(
        `[DRY RUN] Would ${isReply ? 'reply' : 'publish'} for Mastodon post ID ${postId} (${text.length} characters).`,
      );
    };

    for (let i = mastodonArr.length - 1; i >= 0; i--) {
      console.log(
        `${config.dryRun ? '[DRY RUN] ' : ''}Mirroring Mastodon post ID ${mastIdArr[i]}`,
      );
      if (mastodonArr[i].length <= 300) {
        if (config.dryRun) {
          logDryRunPost(mastIdArr[i], false, mastodonArr[i]);
        } else {
          await bot.post(
            false,
            mastUrlArr[i],
            mastAltArr[i],
            mastCardArr[i],
            mastodonArr[i],
          );
        }
      } else {
        const wordArr = mastodonArr[i].split(' ');
        let chunkLen = 0;
        let chunkArr = [];
        const threadArr = [];
        let chunkStr = '';
        while (wordArr.length !== 0) {
          if (chunkLen + wordArr[0].length <= 294) {
            chunkLen += wordArr[0].length + 1;
            chunkArr.push(wordArr.shift());
          } else {
            chunkStr = chunkArr.join(' ');
            chunkArr = [];
            chunkLen = 0;
            threadArr.push(chunkStr);
          }
        }
        chunkStr = chunkArr.join(' ');
        threadArr.push(chunkStr);
        let isReply = false;
        for (let j = 0; j < threadArr.length; j++) {
          const postText = `${threadArr[j]} [${j + 1}/${threadArr.length}]`;
          if (config.dryRun) {
            logDryRunPost(mastIdArr[i], isReply, postText);
          } else {
            await bot.post(
              isReply,
              mastUrlArr[i],
              mastAltArr[i],
              mastCardArr[i],
              postText,
            );
          }
          if (isReply === false) {
            isReply = true;
            mastUrlArr[i] = 'None!^&None!^&None!^&None';
            mastAltArr[i] = 'None!^&None!^&None!^&None';
          }
        }
      }
    }
    return;
  }
}
