import * as Mastodon from 'tsl-mastodon-api';

import { config } from './config.ts';

const mastodon = new Mastodon.API({
  access_token: config.mastodonAccessToken,
  api_url: 'https://mastodon.social/api/v1/',
});

/**
	Fetches the configured Mastodon account's recent statuses and formats them as Bluesky posts.

	@returns A string representing the desired text of the Bluesky posts we want to create. Text for different posts are delimited by \/ characters.
*/
export default async function getPostText(): Promise<string> {
  // Regex list to address formatting discrepancies between Mastodon posts and Bluesky posts
  const pReg = /<\/p><p>/g; // A regex to deal with <p></p>. This should create a new section in the text, which we do via 2 line breaks.
  const brReg = /<br>/g; // A regex to deal with <br>. This should go to the next line, which we do via a line break.
  const quoteReg = /\\"/g; // A regex to deal with \". This should be replaced with a " value with no \.
  const andReg = /&amp;/g; // A regex to deal with &amp;. This should be replaced with &.
  const logoReg = /&nbsp;/g; // A regex to deal with &nbsp;. Should be deleted.
  const twitterReg = /@twitter.com/g; // A regex to deal with @twitter.com. Should be deleted.
  const mastodonHandleReg = new RegExp(
    RegExp.escape(config.mastodonHandle),
    'g',
  );
  const sportsBotsReg = /@sportsbots.xyz/g;
  const tagReg = /<(:?[^>]+)>/g; // A general regex for HTML. Used to get the plaintext value of the mastodon post without tag notation.
  const invalidLinkReg = /\S*(\.com|\.ca|\.org|\.net)\S*(…|\.\.\.)/g;
  const nbcsphillyReg = /@nbcsphilly/g; // Regex example for a substitution within the post text. Can be helpful for if you want to replace an X/Twitter handle with the user's name

  const accountLookup = await mastodon.get('accounts/lookup', {
    acct: config.mastodonHandle,
  });
  if (accountLookup.error || accountLookup.status !== 200) {
    throw new Error(
      `Failed to look up Mastodon account "${config.mastodonHandle}"`,
      { cause: accountLookup.error },
    );
  }

  const account = accountLookup.json;
  if (!account?.id) {
    throw new Error(
      `Mastodon lookup returned no account ID for "${config.mastodonHandle}"`,
    );
  }

  const awaitTweet = await mastodon.getStatuses(account.id, {
    limit: config.postLimit,
  });
  const string = JSON.stringify(awaitTweet); // Convert the post into a JSON string.
  const objJSON = JSON.parse(string).json; // Convert the JSON string back to a JSON object. Kinda silly, but it doesn't work otherwise.
  const stringArr = []; // Initialize an empty array that we will store the regexed plaintexts in.
  const urlArr = [];
  const altTextArr = [];
  const cardArr = [];
  const idArr = [];
  for (
    let i = 0;
    i < config.postLimit;
    i++ // Iterate over all the posts we collected using the Mastodon API.
  ) {
    const postUrlArr = [];
    const postAltTextArr = [];
    idArr.push(objJSON[i].id);
    for (let j = 0; j < 4; j++) {
      if (objJSON[i].media_attachments[j] !== undefined) {
        if (
          objJSON[i].media_attachments[j].type === 'image' ||
          objJSON[i].media_attachments[j].type === 'gifv' ||
          objJSON[i].media_attachments[j].type === 'video'
        ) {
          postUrlArr.push(objJSON[i].media_attachments[j].url);
        } else {
          postUrlArr.push('None');
        }

        if (
          objJSON[i].media_attachments[j].type === 'video' ||
          objJSON[i].media_attachments[j].type === 'gifv'
        ) {
          postAltTextArr.push(
            `${objJSON[i].media_attachments[j].meta.original.width}@#*${objJSON[i].media_attachments[j].meta.original.height}@#*${objJSON[i].media_attachments[j].meta.original.duration}@#*${objJSON[i].media_attachments[j].preview_url}`,
          );
        } else if (objJSON[i].media_attachments[j].description == null) {
          postAltTextArr.push('None');
        } else {
          postAltTextArr.push(objJSON[i].media_attachments[j].description);
        }
      } else {
        postUrlArr.push('None');
        postAltTextArr.push('None');
      }
    }
    const postUrl = postUrlArr.join('!^&');
    const postAltText = postAltTextArr.join('!^&');
    urlArr.push(postUrl);
    altTextArr.push(postAltText);
    const contentJSON = objJSON[i].content; // Filter through all the values of the JSON object, to get just the content of post i.
    let contentString = JSON.stringify(contentJSON); // Convert the content of the post into a JSON string.
    contentString = contentString.slice(1, -1); // Remove the quotation marks.
    contentString = contentString.replace(pReg, '\n\n');
    contentString = contentString.replace(brReg, '\n');
    contentString = contentString.replace(quoteReg, `"`);
    contentString = contentString.replace(andReg, '&'); //Use the ", &, <p>, and <br> regexes to apply appropriate formatting. Then use the general regex to remove the HTML formatting from the Mastodon post.
    contentString = contentString.replace(logoReg, '');
    contentString = contentString.replace(twitterReg, '');
    contentString = contentString.replace(mastodonHandleReg, config.bskyHandle);
    contentString = contentString.replace(sportsBotsReg, '');
    contentString = contentString.replace(tagReg, '');
    contentString = contentString.replace(nbcsphillyReg, 'NBCSP');

    if (
      contentString.includes('RT ') ||
      contentString.includes('Retweet ') ||
      contentString.includes('retweet ') ||
      contentString.includes('RETWEET ')
    ) {
      contentString = `${contentString}\n\n (Offer not valid on Bluesky.)`;
    }

    if (objJSON[i].card != null) {
      contentString = contentString.replace(
        invalidLinkReg,
        objJSON[i].card.url,
      );
      const postCardArr = [];
      postCardArr.push(objJSON[i].card.url);
      postCardArr.push(objJSON[i].card.title);
      postCardArr.push(objJSON[i].card.description);
      postCardArr.push(objJSON[i].card.image);
      const postCard = postCardArr.join('!^&');
      cardArr.push(postCard);
    } else {
      cardArr.push('None');
    }
    stringArr.push(contentString); // Add the regexed content to the array of plaintexts.
  }
  //urlArr[27] = "None!^&None!^&None!^&None";
  //altTextArr[27] = "None!^&None!^&None!^&None";

  const urls = urlArr.join('@#%');
  const strings = stringArr.join('@#%'); // Turn the string array into a single string by joining them with a \/ delimiter. This will be undone when used by bot functions.
  const alts = altTextArr.join('@#%');
  const cards = cardArr.join('@#%');
  const ids = idArr.join('@#%');
  const urlsStringsAltsCardsArr = [urls, strings, alts, cards, ids];
  const urlsStringsAltsCards = urlsStringsAltsCardsArr.join('~~~');
  return urlsStringsAltsCards; // Return this singular concatenated string.
}
