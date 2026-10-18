import type {
  $Typed,
  AppBskyEmbedExternal,
  AppBskyEmbedImages,
  AppBskyFeedPost,
} from '@atproto/api';
import { AtpAgent, RichText } from '@atproto/api';

import { config } from './config.ts';
import getPostText from './getPostText.ts';

async function fetchBuffer(mediaUrl: string): Promise<Buffer> {
  const mediaResponse = await fetch(mediaUrl);
  if (!mediaResponse.ok) {
    throw new Error(
      `Failed to fetch ${mediaUrl}: ${mediaResponse.status} ${mediaResponse.statusText}`,
    );
  }
  return Buffer.from(await mediaResponse.arrayBuffer());
}

function getFeedPostText(postRecord: unknown): string | undefined {
  if (
    typeof postRecord === 'object' &&
    postRecord !== null &&
    'text' in postRecord &&
    typeof postRecord.text === 'string'
  ) {
    return postRecord.text;
  }
  return undefined;
}

function isDuplicateOrEmpty(
  postText: string,
  recentPostTexts: readonly string[],
) {
  return postText.length === 0 || recentPostTexts.includes(postText);
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
   * @param bskyHandle - Bluesky account handle.
   * @param password - Bluesky account password.
   */
  async login(bskyHandle: string, password: string) {
    await this.blueskyAgent.login({
      identifier: bskyHandle,
      password,
    });
  }

  /**
   * Retrieves recent text records from the configured Bluesky account.
   *
   * @returns Text from recent feed records that contain a string value.
   */
  async getRecentPostTexts() {
    const feedResponse = await this.blueskyAgent.app.bsky.feed.getAuthorFeed({
      actor: config.bskyHandle,
      limit: config.postLimit,
    });
    return feedResponse.data.feed
      .map(({ post }) => getFeedPostText(post.record))
      .filter((postText): postText is string => postText !== undefined);
  }

  /**
   * Publishes a video post unless its text is empty or already in the recent feed.
   *
   * @param videoUrl - URL of the video to upload.
   * @param videoMetadata - Encoded video dimensions and thumbnail metadata.
   * @param postText - Text or feed record to publish.
   * @returns A promise that resolves when the video is published or skipped.
   */
  async postVideo(
    videoUrl: string,
    videoMetadata: string,
    postText:
      | string
      | (Partial<AppBskyFeedPost.Record> &
          Omit<AppBskyFeedPost.Record, 'createdAt'>),
  ): Promise<void> {
    const feedResponse = await this.blueskyAgent.app.bsky.feed.getAuthorFeed({
      actor: config.bskyHandle,
      limit: config.postLimit,
    });
    const recentFeed = feedResponse.data.feed;
    const recentPostTexts = recentFeed
      .map(({ post }) => getFeedPostText(post.record))
      .filter((feedText): feedText is string => feedText !== undefined);

    if (
      typeof postText === 'string' &&
      isDuplicateOrEmpty(postText, recentPostTexts)
    ) {
      console.log(`Post has already been mirrored.`);
      return;
    } else if (typeof postText !== 'string') {
      return;
    }

    const videoMetadataFields = videoMetadata.split('@#*');

    const videoBuffer = await fetchBuffer(videoUrl);

    const videoUploadResponse =
      await this.blueskyAgent.com.atproto.repo.uploadBlob(
        new Uint8Array(videoBuffer),
      );

    if (!videoUploadResponse.data?.blob) {
      throw new Error('Failed to upload video: no blob returned.');
    }

    console.log('Video uploaded, posting...');

    await this.blueskyAgent.post({
      text: postText,
      langs: ['en'],
      embed: {
        $type: 'app.bsky.embed.video',
        video: videoUploadResponse.data.blob,
        aspectRatio: {
          width: parseInt(videoMetadataFields[0], 10),
          height: parseInt(videoMetadataFields[1], 10),
        },
      },
    });
  }

  /**
   * Publishes a post or reply with any available media or link-card embeds.
   *
   * @param isReply - Whether the post should reply to the preceding thread post.
   * @param encodedMediaUrls - Encoded media URLs associated with the source post.
   * @param encodedMediaAltTexts - Encoded media descriptions and video metadata.
   * @param encodedLinkCard - Encoded link-card metadata, or `None` when absent.
   * @param postText - Text or feed record to publish.
   * @returns The Bluesky post response, or `37` when the post is skipped.
   */
  async post(
    isReply: boolean,
    encodedMediaUrls: string,
    encodedMediaAltTexts: string,
    encodedLinkCard: string,
    postText:
      | string
      | (Partial<AppBskyFeedPost.Record> &
          Omit<AppBskyFeedPost.Record, 'createdAt'>),
  ) {
    let imageEmbed: $Typed<AppBskyEmbedImages.Main> | undefined;
    const mediaUrls = encodedMediaUrls.split('!^&');
    const mediaAltTexts = encodedMediaAltTexts.split('!^&');
    const linkCardFields = encodedLinkCard.split('!^&');
    let linkCardEmbed: $Typed<AppBskyEmbedExternal.Main> | undefined;

    const { data: serviceAuth } =
      await this.blueskyAgent.com.atproto.server.getServiceAuth({
        aud: 'did:web:video.bsky.app',
        lxm: 'app.bsky.video.getUploadLimits',
        exp: Date.now() / 1000 + 60 * 30,
      });
    const token = serviceAuth.token;
    const videoUploadLimitsUrl =
      'https://video.bsky.app/xrpc/app.bsky.video.getUploadLimits';
    const videoUploadLimitsResponse = await fetch(videoUploadLimitsUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!videoUploadLimitsResponse.ok) {
      throw new Error(
        `Failed to fetch video upload limits: ${videoUploadLimitsResponse.status} ${videoUploadLimitsResponse.statusText}`,
      );
    }
    const videoUploadLimits = await videoUploadLimitsResponse.json();

    if (
      mediaUrls[0].slice(-3) === 'mp4' &&
      parseFloat(mediaAltTexts[0].split('@#*')[2]) <= 600 &&
      videoUploadLimits.canUpload === true
    ) {
      await this.postVideo(mediaUrls[0], mediaAltTexts[0], postText);
      return 37;
    } else {
      if (mediaUrls[0].slice(-3) === 'mp4') {
        mediaUrls[0] = mediaAltTexts[0].split('@#*')[3];
        if (videoUploadLimits.canUpload === false) {
          mediaAltTexts[0] =
            'The bot has posted its maximum number of videos for the day. This is the thumbnail of the video instead.';
        } else {
          mediaAltTexts[0] =
            'The video is too long to be posted on Bluesky. This is the thumbnail of the video instead.';
        }
      }
      if (encodedLinkCard !== 'None' && mediaUrls[0] === 'None') {
        const linkCardImageBuffer = await fetchBuffer(linkCardFields[3]);
        const linkCardImageUpload =
          await this.blueskyAgent.com.atproto.repo.uploadBlob(
            new Uint8Array(linkCardImageBuffer),
            { encoding: 'image/png' },
          );
        const externalLinkCard = {
          uri: linkCardFields[0],
          title: linkCardFields[1],
          description: linkCardFields[2],
          thumb: linkCardImageUpload.data.blob,
        };
        linkCardEmbed = {
          $type: 'app.bsky.embed.external',
          external: externalLinkCard,
        };
      }

      for (const [attachmentIndex, mediaUrl] of mediaUrls.entries()) {
        if (mediaUrl !== 'None') {
          const imageBuffer = await fetchBuffer(mediaUrl);
          if (imageBuffer.length <= 1000000) {
            const imageUploadResponse =
              await this.blueskyAgent.com.atproto.repo.uploadBlob(
                new Uint8Array(imageBuffer),
                { encoding: 'image/png' },
              );
            if (imageEmbed === undefined) {
              if (mediaAltTexts[attachmentIndex] !== 'None') {
                imageEmbed = {
                  images: [
                    {
                      image: imageUploadResponse.data.blob,
                      alt: mediaAltTexts[attachmentIndex],
                    },
                  ],
                  $type: 'app.bsky.embed.images',
                };
              } else {
                imageEmbed = {
                  images: [{ image: imageUploadResponse.data.blob, alt: '' }],
                  $type: 'app.bsky.embed.images',
                };
              }
            } else {
              if (mediaAltTexts[attachmentIndex] !== 'None') {
                imageEmbed.images.push({
                  image: imageUploadResponse.data.blob,
                  alt: mediaAltTexts[attachmentIndex],
                });
              } else {
                imageEmbed.images.push({
                  image: imageUploadResponse.data.blob,
                  alt: '',
                });
              }
            }
          }
        }
      }

      const feedResponse = await this.blueskyAgent.app.bsky.feed.getAuthorFeed({
        actor: config.bskyHandle,
        limit: config.postLimit,
      });
      const recentFeed = feedResponse.data.feed;
      let parentPostReference = { uri: '', cid: '' };
      if (isReply === false) {
        this.rootUri = '';
        this.rootCid = '';
      } else {
        const latestFeedPost = recentFeed[0]?.post;
        if (!latestFeedPost) {
          throw new Error(
            'Cannot create a reply because the Bluesky author feed has no posts.',
          );
        }
        const latestPostUri = latestFeedPost.uri;
        const latestPostCid = latestFeedPost.cid;
        parentPostReference = { uri: latestPostUri, cid: latestPostCid };
        if (this.rootUri === '') {
          this.rootUri = latestPostUri;
          this.rootCid = latestPostCid;
        }
      }
      const recentPostTexts = recentFeed
        .map(({ post }) => getFeedPostText(post.record))
        .filter((feedText): feedText is string => feedText !== undefined);
      if (
        typeof postText === 'string' &&
        isDuplicateOrEmpty(postText, recentPostTexts)
      ) {
        console.log('Post has already been mirrored.');
        return '37';
      }
      if (typeof postText === 'string') {
        const richText = new RichText({ text: postText });
        await richText.detectFacets(this.blueskyAgent);
        let postRecord: Partial<AppBskyFeedPost.Record> &
          Omit<AppBskyFeedPost.Record, 'createdAt'>;
        if (isReply === true) {
          const rootPostReference = { uri: this.rootUri, cid: this.rootCid };
          if (mediaUrls[0] !== 'None') {
            postRecord = {
              text: richText.text,
              facets: richText.facets,
              reply: {
                root: rootPostReference,
                parent: parentPostReference,
              },
              embed: imageEmbed,
            };
          } else if (encodedLinkCard !== 'None') {
            postRecord = {
              text: richText.text,
              facets: richText.facets,
              reply: {
                root: rootPostReference,
                parent: parentPostReference,
              },
              embed: linkCardEmbed,
            };
            console.log('record with card');
            console.log(postRecord);
          } else {
            postRecord = {
              text: richText.text,
              facets: richText.facets,
              reply: {
                root: rootPostReference,
                parent: parentPostReference,
              },
            };
          }
        } else {
          if (mediaUrls[0] !== 'None') {
            console.log('there is a url.');
            postRecord = {
              text: richText.text,
              facets: richText.facets,
              embed: imageEmbed,
            };
          } else if (encodedLinkCard !== 'None') {
            console.log('there is a card.');
            postRecord = {
              text: richText.text,
              facets: richText.facets,
              embed: linkCardEmbed,
            };
            console.log('record with card');
            console.log(postRecord);
          } else {
            console.log('no url or card');
            postRecord = {
              text: richText.text,
              facets: richText.facets,
            };
          }
        }
        return this.blueskyAgent.post(postRecord);
      } else {
        return this.blueskyAgent.post(postText);
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
    const serializedMastodonPostData = await getPostText();

    const mastodonPostDataFields = serializedMastodonPostData.split('~~~');
    const mastodonPostMediaUrls = mastodonPostDataFields[0].split('@#%');
    const mastodonPostTexts = mastodonPostDataFields[1].split('@#%');
    const mastodonPostMediaAltTexts = mastodonPostDataFields[2].split('@#%');
    const mastodonPostLinkCards = mastodonPostDataFields[3].split('@#%');
    const mastodonPostIds = mastodonPostDataFields[4].split('@#%');

    const logDryRunPost = (
      postId: string,
      isReply: boolean,
      postText: string,
    ) => {
      if (dryRunFeedTexts && isDuplicateOrEmpty(postText, dryRunFeedTexts)) {
        console.log(`[DRY RUN] Post ${postId} has already been mirrored.`);
        return;
      }
      console.log(
        `[DRY RUN] Would ${isReply ? 'reply' : 'publish'} for Mastodon post ID ${postId} (${postText.length} characters).`,
      );
    };

    const mastodonPosts = mastodonPostTexts
      .map((postText, postIndex) => ({
        postId: mastodonPostIds[postIndex],
        text: postText,
        mediaUrls: mastodonPostMediaUrls[postIndex],
        mediaAltTexts: mastodonPostMediaAltTexts[postIndex],
        linkCard: mastodonPostLinkCards[postIndex],
      }))
      .reverse();

    for (const mastodonPost of mastodonPosts) {
      let mediaUrls = mastodonPost.mediaUrls;
      let mediaAltTexts = mastodonPost.mediaAltTexts;
      console.log(
        `${config.dryRun ? '[DRY RUN] ' : ''}Mirroring Mastodon post ID ${mastodonPost.postId}`,
      );
      if (mastodonPost.text.length <= 300) {
        if (config.dryRun) {
          logDryRunPost(mastodonPost.postId, false, mastodonPost.text);
        } else {
          await bot.post(
            false,
            mediaUrls,
            mediaAltTexts,
            mastodonPost.linkCard,
            mastodonPost.text,
          );
        }
      } else {
        const words = mastodonPost.text.split(' ');
        let chunkLength = 0;
        let chunkWords = [];
        const threadPosts = [];
        for (const word of words) {
          if (chunkLength + word.length > 294 && chunkWords.length > 0) {
            threadPosts.push(chunkWords.join(' '));
            chunkWords = [];
            chunkLength = 0;
          }
          chunkLength += word.length + 1;
          chunkWords.push(word);
        }
        threadPosts.push(chunkWords.join(' '));
        let isReply = false;
        for (const [threadPostIndex, threadPost] of threadPosts.entries()) {
          const postText = `${threadPost} [${threadPostIndex + 1}/${threadPosts.length}]`;
          if (config.dryRun) {
            logDryRunPost(mastodonPost.postId, isReply, postText);
          } else {
            await bot.post(
              isReply,
              mediaUrls,
              mediaAltTexts,
              mastodonPost.linkCard,
              postText,
            );
          }
          if (isReply === false) {
            isReply = true;
            mediaUrls = 'None!^&None!^&None!^&None';
            mediaAltTexts = 'None!^&None!^&None!^&None';
          }
        }
      }
    }
    return;
  }
}
