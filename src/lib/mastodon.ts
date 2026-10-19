import type { API } from 'tsl-mastodon-api';

import { config } from './config.ts';

export interface MastodonVideoMetadata {
  width: number;
  height: number;
  duration: number;
  previewUrl: string;
}

export interface MastodonMediaAttachment {
  url?: string;
  altText?: string;
  video?: MastodonVideoMetadata;
}

export interface MastodonLinkCard {
  url: string;
  title: string;
  description: string;
  image?: string;
}

export interface MastodonPostData {
  postId: string;
  text: string;
  mediaAttachments: MastodonMediaAttachment[];
  linkCard?: MastodonLinkCard;
}

/**
 * Fetches and formats recent statuses from the configured Mastodon account.
 *
 * @returns Structured post text and associated media metadata.
 */
export async function getMastodonPosts(
  mastodonApi: API,
  account: string,
): Promise<MastodonPostData[]> {
  const paragraphBoundaryRegExp = /<\/p><p>/g;
  const lineBreakRegExp = /<br>/g;
  const escapedQuoteRegExp = /\\"/g;
  const ampersandEntityRegExp = /&amp;/g;
  const nonbreakingSpaceEntityRegExp = /&nbsp;/g;
  const twitterDomainMentionRegExp = /@twitter.com/g;
  const mastodonHandleRegExp = new RegExp(RegExp.escape(account), 'g');
  const sportsBotsMentionRegExp = /@sportsbots.xyz/g;
  const htmlTagRegExp = /<(:?[^>]+)>/g;
  const truncatedUrlRegExp = /\S*(\.com|\.ca|\.org|\.net)\S*(…|\.\.\.)/g;
  const nbcSportsPhillyMentionRegExp = /@nbcsphilly/g;

  const accountLookupResponse = await mastodonApi.get('accounts/lookup', {
    acct: account,
  });
  if (accountLookupResponse.error || accountLookupResponse.status !== 200) {
    throw new Error(`Failed to look up Mastodon account "${account}"`, {
      cause: accountLookupResponse.error,
    });
  }

  const mastodonAccount = accountLookupResponse.json;
  if (!mastodonAccount?.id) {
    throw new Error(`Mastodon lookup returned no account ID for "${account}"`);
  }

  const mastodonStatusesResponse = await mastodonApi.getStatuses(
    mastodonAccount.id,
    {
      limit: config.postLimit,
      ...(config.lastMastodonId ? { since_id: config.lastMastodonId } : {}),
    },
  );

  const statuses = mastodonStatusesResponse.json;

  const posts: MastodonPostData[] = [];
  for (const status of statuses) {
    const mediaAttachments = status.media_attachments
      .slice(0, 4)
      .map((attachment): MastodonMediaAttachment => {
        if (
          attachment.type !== 'image' &&
          attachment.type !== 'gifv' &&
          attachment.type !== 'video'
        ) {
          return {};
        }

        if (attachment.type === 'video' || attachment.type === 'gifv') {
          return {
            url: attachment.url ?? undefined,
            video: {
              width: attachment.meta.original.width,
              height: attachment.meta.original.height,
              duration: attachment.meta.original.duration,
              previewUrl: attachment.preview_url,
            },
          };
        }

        return {
          url: attachment.url ?? undefined,
          ...(attachment.description
            ? { altText: attachment.description }
            : {}),
        };
      });
    const serializedContent = JSON.stringify(status.content);
    let postText = serializedContent.slice(1, -1);
    postText = postText.replace(paragraphBoundaryRegExp, '\n\n');
    postText = postText.replace(lineBreakRegExp, '\n');
    postText = postText.replace(escapedQuoteRegExp, `"`);
    postText = postText.replace(ampersandEntityRegExp, '&');
    postText = postText.replace(nonbreakingSpaceEntityRegExp, '');
    postText = postText.replace(twitterDomainMentionRegExp, '');
    postText = postText.replace(mastodonHandleRegExp, config.bskyHandle);
    postText = postText.replace(sportsBotsMentionRegExp, '');
    postText = postText.replace(htmlTagRegExp, '');
    postText = postText.replace(nbcSportsPhillyMentionRegExp, 'NBCSP');

    if (
      postText.includes('RT ') ||
      postText.includes('Retweet ') ||
      postText.includes('retweet ') ||
      postText.includes('RETWEET ')
    ) {
      postText = `${postText}\n\n (Offer not valid on Bluesky.)`;
    }

    let linkCard: MastodonLinkCard | undefined;
    if (status.card != null) {
      postText = postText.replace(truncatedUrlRegExp, status.card.url);
      linkCard = {
        url: status.card.url,
        title: status.card.title,
        description: status.card.description,
        ...('image' in status.card && status.card.image
          ? { image: status.card.image }
          : {}),
      };
    }
    posts.push({
      postId: status.id,
      text: postText,
      mediaAttachments,
      ...(linkCard ? { linkCard } : {}),
    });
  }

  return posts;
}
