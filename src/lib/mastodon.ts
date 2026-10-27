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
  inReplyToId?: string;
  text: string;
  mediaAttachments: MastodonMediaAttachment[];
  linkCard?: MastodonLinkCard;
}

const postTextReplacements = (
  account: string,
): { pattern: RegExp; replacement: string }[] => [
  { pattern: /<\/p><p>/g, replacement: '\n\n' },
  { pattern: /<br>/g, replacement: '\n' },
  { pattern: /&amp;/g, replacement: '&' },
  {
    pattern: new RegExp(RegExp.escape(account), 'g'),
    replacement: config.bskyHandle,
  },
  {
    pattern: /(?:&nbsp;|@twitter\.com|@sportsbots\.xyz|<:?[^>]+>)/g,
    replacement: '',
  },
];

/**
 * Fetches and formats recent statuses from the configured Mastodon account.
 *
 * @returns Structured post text and associated media metadata.
 */
export async function getMastodonPosts(
  mastodonApi: API,
  account: string,
): Promise<MastodonPostData[]> {
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
    if (status.reblog || !status.content.trim()) {
      continue;
    }

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

    let postText = status.content;

    const replacements = postTextReplacements(account);
    for (const { pattern, replacement } of replacements) {
      postText = postText.replace(pattern, replacement);
    }

    let linkCard: MastodonLinkCard | undefined;
    if (status.card != null) {
      postText = postText.replace(
        /\S*(\.com|\.ca|\.org|\.net)\S*(…|\.\.\.)/g,
        status.card.url,
      );

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
      ...(status.in_reply_to_id ? { inReplyToId: status.in_reply_to_id } : {}),
      text: postText,
      mediaAttachments,
      ...(linkCard ? { linkCard } : {}),
    });
  }

  return posts;
}
