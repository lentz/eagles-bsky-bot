import type { API } from 'tsl-mastodon-api';

import { config } from './config.ts';

/**
 * Fetches and formats recent statuses from the configured Mastodon account.
 *
 * @returns A serialized string containing post text and associated media metadata.
 */
export async function getMastodonPosts(
  mastodonApi: API,
  account: string,
): Promise<string> {
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
    },
  );
  const serializedStatusesResponse = JSON.stringify(mastodonStatusesResponse);
  const statuses = JSON.parse(serializedStatusesResponse).json;
  const postTexts = [];
  const postMediaUrls = [];
  const postMediaAltTexts = [];
  const postLinkCards = [];
  const postIds = [];
  for (const status of statuses.slice(0, config.postLimit)) {
    const mediaUrls = [];
    const mediaAltTexts = [];
    postIds.push(status.id);
    const attachments = Array.from(
      { length: 4 },
      (_, attachmentIndex) => status.media_attachments[attachmentIndex],
    );
    for (const attachment of attachments) {
      if (attachment !== undefined) {
        if (
          attachment.type === 'image' ||
          attachment.type === 'gifv' ||
          attachment.type === 'video'
        ) {
          mediaUrls.push(attachment.url);
        } else {
          mediaUrls.push('None');
        }

        if (attachment.type === 'video' || attachment.type === 'gifv') {
          mediaAltTexts.push(
            `${attachment.meta.original.width}@#*${attachment.meta.original.height}@#*${attachment.meta.original.duration}@#*${attachment.preview_url}`,
          );
        } else if (attachment.description == null) {
          mediaAltTexts.push('None');
        } else {
          mediaAltTexts.push(attachment.description);
        }
      } else {
        mediaUrls.push('None');
        mediaAltTexts.push('None');
      }
    }
    postMediaUrls.push(mediaUrls.join('!^&'));
    postMediaAltTexts.push(mediaAltTexts.join('!^&'));
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

    if (status.card != null) {
      postText = postText.replace(truncatedUrlRegExp, status.card.url);
      const linkCardFields = [];
      linkCardFields.push(status.card.url);
      linkCardFields.push(status.card.title);
      linkCardFields.push(status.card.description);
      linkCardFields.push(status.card.image);
      postLinkCards.push(linkCardFields.join('!^&'));
    } else {
      postLinkCards.push('None');
    }
    postTexts.push(postText);
  }

  const serializedPostData = [
    postMediaUrls.join('@#%'),
    postTexts.join('@#%'),
    postMediaAltTexts.join('@#%'),
    postLinkCards.join('@#%'),
    postIds.join('@#%'),
  ];
  return serializedPostData.join('~~~');
}
