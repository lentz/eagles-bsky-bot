import { appendFile } from 'node:fs/promises';
import type {
  $Typed,
  AppBskyEmbedExternal,
  AppBskyEmbedImages,
  AppBskyFeedPost,
} from '@atproto/api';
import { type AtpAgent, RichText } from '@atproto/api';
import type { API } from 'tsl-mastodon-api';

import { config } from './config.ts';
import {
  getMastodonPosts,
  type MastodonLinkCard,
  type MastodonMediaAttachment,
  type MastodonVideoMetadata,
} from './mastodon.ts';

async function fetchBuffer(mediaUrl: string): Promise<Buffer> {
  const mediaResponse = await fetch(mediaUrl);
  if (!mediaResponse.ok) {
    throw new Error(
      `Failed to fetch ${mediaUrl}: ${mediaResponse.status} ${mediaResponse.statusText}`,
    );
  }
  return Buffer.from(await mediaResponse.arrayBuffer());
}

export default class Bot {
  blueskyAgent: AtpAgent;

  public rootCid = '';
  public rootUri = '';

  constructor(blueskyAgent: AtpAgent) {
    this.blueskyAgent = blueskyAgent;
  }

  /**
   * Publishes a video post unless its text is empty.
   *
   * @param videoUrl - URL of the video to upload.
   * @param videoMetadata - Encoded video dimensions and thumbnail metadata.
   * @param postText - Text or feed record to publish.
   * @returns A promise that resolves when the video is published or skipped.
   */
  async postVideo(
    videoUrl: string,
    videoMetadata: MastodonVideoMetadata,
    postText:
      | string
      | (Partial<AppBskyFeedPost.Record> &
          Omit<AppBskyFeedPost.Record, 'createdAt'>),
  ): Promise<void> {
    if (typeof postText !== 'string') {
      return;
    }

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
          width: videoMetadata.width,
          height: videoMetadata.height,
        },
      },
    });
  }

  /**
   * Publishes a post or reply with any available media or link-card embeds.
   *
   * @param isReply - Whether the post should reply to the preceding thread post.
   * @param mediaAttachments - Media attachments associated with the source post.
   * @param linkCard - Link-card metadata, when present.
   * @param postText - Text or feed record to publish.
   * @returns The Bluesky post response, or `37` when the post is skipped.
   */
  async post(
    isReply: boolean,
    mediaAttachments: MastodonMediaAttachment[],
    linkCard: MastodonLinkCard | undefined,
    postText:
      | string
      | (Partial<AppBskyFeedPost.Record> &
          Omit<AppBskyFeedPost.Record, 'createdAt'>),
  ) {
    let imageEmbed: $Typed<AppBskyEmbedImages.Main> | undefined;
    let linkCardEmbed: $Typed<AppBskyEmbedExternal.Main> | undefined;
    const firstAttachment = mediaAttachments[0];
    let firstMediaUrl = firstAttachment?.url;
    let firstMediaAltText = firstAttachment?.altText;

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
      firstMediaUrl?.slice(-3) === 'mp4' &&
      firstAttachment?.video?.duration !== undefined &&
      firstAttachment.video.duration <= 600 &&
      videoUploadLimits.canUpload === true
    ) {
      await this.postVideo(firstMediaUrl, firstAttachment.video, postText);
      return 37;
    } else {
      if (firstMediaUrl?.slice(-3) === 'mp4' && firstAttachment?.video) {
        firstMediaUrl = firstAttachment.video.previewUrl;
        if (videoUploadLimits.canUpload === false) {
          firstMediaAltText =
            'The bot has posted its maximum number of videos for the day. This is the thumbnail of the video instead.';
        } else {
          firstMediaAltText =
            'The video is too long to be posted on Bluesky. This is the thumbnail of the video instead.';
        }
      }
      if (linkCard && firstMediaUrl === undefined && linkCard.image) {
        const linkCardImageBuffer = await fetchBuffer(linkCard.image);
        const linkCardImageUpload =
          await this.blueskyAgent.com.atproto.repo.uploadBlob(
            new Uint8Array(linkCardImageBuffer),
            { encoding: 'image/png' },
          );
        const externalLinkCard = {
          uri: linkCard.url,
          title: linkCard.title,
          description: linkCard.description,
          thumb: linkCardImageUpload.data.blob,
        };
        linkCardEmbed = {
          $type: 'app.bsky.embed.external',
          external: externalLinkCard,
        };
      }

      for (const [attachmentIndex, attachment] of mediaAttachments.entries()) {
        const mediaUrl = attachmentIndex === 0 ? firstMediaUrl : attachment.url;
        if (mediaUrl !== undefined) {
          const imageBuffer = await fetchBuffer(mediaUrl);
          if (imageBuffer.length <= 1000000) {
            const imageUploadResponse =
              await this.blueskyAgent.com.atproto.repo.uploadBlob(
                new Uint8Array(imageBuffer),
                { encoding: 'image/png' },
              );
            if (imageEmbed === undefined) {
              const altText =
                attachmentIndex === 0 ? firstMediaAltText : attachment.altText;
              if (altText !== undefined) {
                imageEmbed = {
                  images: [
                    {
                      image: imageUploadResponse.data.blob,
                      alt: altText,
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
              const altText =
                attachmentIndex === 0 ? firstMediaAltText : attachment.altText;
              if (altText !== undefined) {
                imageEmbed.images.push({
                  image: imageUploadResponse.data.blob,
                  alt: altText,
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
      if (typeof postText === 'string') {
        const richText = new RichText({ text: postText });
        await richText.detectFacets(this.blueskyAgent);
        let postRecord: Partial<AppBskyFeedPost.Record> &
          Omit<AppBskyFeedPost.Record, 'createdAt'>;
        if (isReply === true) {
          const rootPostReference = { uri: this.rootUri, cid: this.rootCid };
          if (firstMediaUrl !== undefined) {
            console.log('Posting reply with URL');
            postRecord = {
              text: richText.text,
              facets: richText.facets,
              reply: {
                root: rootPostReference,
                parent: parentPostReference,
              },
              embed: imageEmbed,
            };
          } else if (linkCard) {
            console.log('Posting reply with card');
            postRecord = {
              text: richText.text,
              facets: richText.facets,
              reply: {
                root: rootPostReference,
                parent: parentPostReference,
              },
              embed: linkCardEmbed,
            };
          } else {
            console.log('Posting reply text');
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
          if (firstMediaUrl !== undefined) {
            console.log('Posting with URL');
            postRecord = {
              text: richText.text,
              facets: richText.facets,
              embed: imageEmbed,
            };
          } else if (linkCard) {
            console.log('Posting card');
            postRecord = {
              text: richText.text,
              facets: richText.facets,
              embed: linkCardEmbed,
            };
          } else {
            console.log('Posting text');
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
  static async run(blueskyAgent: AtpAgent, mastodonApi: API) {
    const bot = new Bot(blueskyAgent);
    const mastodonPosts = await getMastodonPosts(
      mastodonApi,
      config.mastodonHandle,
    );

    if (mastodonPosts.length === 0) {
      console.log('No posts to mirror.');
    }

    const logDryRunPost = (
      postId: string,
      isReply: boolean,
      postText: string,
    ) => {
      console.log(
        `[DRY RUN] Would ${isReply ? 'reply' : 'publish'} for Mastodon post ID ${postId} (${postText.length} characters).`,
      );
    };

    for (const mastodonPost of [...mastodonPosts].reverse()) {
      let mediaAttachments = mastodonPost.mediaAttachments;
      console.log(
        `${config.dryRun ? '[DRY RUN] ' : ''}Mirroring Mastodon post ID ${mastodonPost.postId} from ${config.mastodonHandle} to ${config.bskyHandle}`,
      );
      if (mastodonPost.text.length <= 300) {
        if (config.dryRun) {
          logDryRunPost(mastodonPost.postId, false, mastodonPost.text);
        } else {
          await bot.post(
            false,
            mediaAttachments,
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
              mediaAttachments,
              mastodonPost.linkCard,
              postText,
            );
          }
          if (isReply === false) {
            isReply = true;
            mediaAttachments = [];
          }
        }
      }
      if (!config.dryRun && mastodonPost.postId && config.githubOutput) {
        await appendFile(
          config.githubOutput,
          `last_mastodon_id=${mastodonPost.postId}\n`,
          'utf8',
        );
      }
    }
    return;
  }
}
