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

  async login(loginOpts: AtpAgentLoginOpts) {
    await this.blueskyAgent.login(loginOpts);
  }

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
    Performs a Bluesky POST request to the agent that has been logged in, posting the plaintext supplied by the text argument. Checks the text first to ensure that the text has not been posted recently by this user, and that the text is not blank. If either of these are the case, return an arbitrary value instead.

    @returns The output of a successful Agent.post request if successful, int 37 on invalid input.
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
    const bskyFeed = bskyFeedAwait.data.feed; // Filter down the await values so we are only looking at the feeds.
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

    // Fetch the video as a buffer
    const videoBuffer = await fetchBuffer(url);

    // Upload the video
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
      ); // Get a defined number + 2 of most recent posts from the logged in user's feed.
      const bskyFeed = bskyFeedAwait.data.feed; // Filter down the await values so we are only looking at the feeds.
      let parentId = { uri: '', cid: '' }; // Initialize the parent ID as 2 empty strings. This should never matter, because it shouldn't be possible to use parentId without assigning it.
      if (isReply === false) {
        // Check if this is not a reply, meaning it is a root post.
        this.rootUri = ''; // Reset the root URI to the empty string, since we are no longer replying under a previous post.
        this.rootCid = ''; // Reset the root CID to the empty string, since we are no longer replying under a previous post.
      } // If this is a reply
      else {
        const bskyPost0 = bskyFeed[0]?.post;
        if (!bskyPost0) {
          throw new Error(
            'Cannot create a reply because the Bluesky author feed has no posts.',
          );
        }
        const bskyUri = bskyPost0.uri; // Collect the URI from the most recent post by the logged in user.
        const bskyCid = bskyPost0.cid; // Collect the CID from the most recent post by the logged in user.
        parentId = { uri: bskyUri, cid: bskyCid }; // Create an ID object using the URI and CID from the most recent post.
        if (this.rootUri === '') {
          // Only change the root once per thread. Root stays constant regardless of if this is post 2 or post 37.
          this.rootUri = bskyUri; // Change the root URI to be the most recent post's URI.
          this.rootCid = bskyCid; // Change the root CID to be the most recent post's CID.
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
        // Check that text is a string (This should always be the case in this codebase, but it seems to break if I get rid of the option for it to not be.)
        const richText = new RichText({ text }); // Create a new RichText object from our text string. Sorta arcane object type detailed in ATProto API.
        await richText.detectFacets(this.blueskyAgent); // Detect facets from the agent.
        let record: Partial<AppBskyFeedPost.Record> &
          Omit<AppBskyFeedPost.Record, 'createdAt'>; // Create empty record variable that we will put our post details into.
        if (isReply === true) {
          // If we are trying to post a reply
          const rootId = { uri: this.rootUri, cid: this.rootCid }; // Format the root URI and root CID from the public object variables into a form that can be used.
          if (urls[0] !== 'None') {
            record = {
              text: richText.text, // Specify the text of our post as the text in the RichText obj (should be our plaintext string)
              facets: richText.facets, // Specify the facets of our post to be the facets of the RichText.
              reply: { root: rootId, parent: parentId }, // Specify the reply details. Make the root the values from our public root variables, make the parent the ID values collected from this function (the ones from the most recent post)
              embed: img,
            };
          } else if (card !== 'None') {
            record = {
              text: richText.text, // Specify the text of our post as the text in the RichText obj (should be our plaintext string)
              facets: richText.facets, // Specify the facets of our post to be the facets of the RichText.
              reply: { root: rootId, parent: parentId }, // Specify the reply details. Make the root the values from our public root variables, make the parent the ID values collected from this function (the ones from the most recent post)
              embed: cardEmbed,
            };
            console.log('record with card');
            console.log(record);
          } else {
            record = {
              text: richText.text, // Specify the text of our post as the text in the RichText obj (should be our plaintext string)
              facets: richText.facets, // Specify the facets of our post to be the facets of the RichText.
              reply: { root: rootId, parent: parentId }, // Specify the reply details. Make the root the values from our public root variables, make the parent the ID values collected from this function (the ones from the most recent post)
            };
          }
        } // If we are trying to post a root post
        else {
          if (urls[0] !== 'None') {
            console.log('there is a url.');
            record = {
              text: richText.text, // Specify the text of our post as the text in the RichText obj (should be our plaintext string)
              facets: richText.facets, // Specify the facets of our post to be the facets of the RichText.
              embed: img,
            };
          } else if (card !== 'None') {
            console.log('there is a card.');
            record = {
              text: richText.text, // Specify the text of our post as the text in the RichText obj (should be our plaintext string)
              facets: richText.facets, // Specify the facets of our post to be the facets of the RichText.
              embed: cardEmbed,
            };
            console.log('record with card');
            console.log(record);
          } else {
            console.log('no url or card');
            record = {
              text: richText.text, // Specify the text of our post as the text in the RichText obj (should be our plaintext string)
              facets: richText.facets, // Specify the facets of our post to be the facets of the RichText.
            };
          }
        }
        return this.blueskyAgent.post(record); // Post the record we have specified using the Bluesky agent, return the output from doing this.
      } // If we are trying to post text not in the format of a string. Shouldn't happen in this unmodified codebase, I don't think
      else {
        return this.blueskyAgent.post(text); // Post the raw text value using the Bluesky agent, return the output from doing this.
      }
    }
  }

  /*
      run(getPostText, botOptions?):

      This function creates the Bot object, collects recent Mastodon posts from the desired Mastodon account, and queues Bot.post requests. This function is also responsible for parsing text from HTML to plaintext, and chunking text longer than 300 characters.

      args:
        getPostText: function value that returns a string value, which is then parsed out into a String[] value. Used to get the most recent Mastodon posts.
        botOptions?: optional BotOptions value that allows us to change the settings of the bot as needed. Default is usually fine.

      returns: void
    */

  static async run() {
    const bot = new Bot();
    await bot.login({
      identifier: config.bskyHandle,
      password: config.bskyPassword,
    });
    const dryRunFeedTexts = config.dryRun
      ? await bot.getRecentPostTexts()
      : undefined;
    const mastodonAwait = await getPostText(); // Get the desired number of recent Mastodon posts from the specified user in getPostText.

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

    for (
      let i = mastodonArr.length - 1;
      i >= 0;
      i-- // Iterate over the recent Mastodon posts in reverse sequential order. -1 may not be necessary, do some more testing.
    ) {
      console.log(
        `${config.dryRun ? '[DRY RUN] ' : ''}Mirroring Mastodon post ID ${mastIdArr[i]}`,
      );
      if (mastodonArr[i].length <= 300) {
        // Simple case, where a post is 300 characters or less, within the length bounds of a Bluesky post.
        if (config.dryRun) {
          logDryRunPost(mastIdArr[i], false, mastodonArr[i]);
        } else {
          await bot.post(
            false,
            mastUrlArr[i],
            mastAltArr[i],
            mastCardArr[i],
            mastodonArr[i],
          ); // Run bot.post on this text value, posting to Bluesky if the text is new. Post this as a root value.
        }
      } // Complicated case where a post is longer than 300 characters, longer than a valid Bluesky post.
      else {
        const wordArr = mastodonArr[i].split(' '); // Turn the string into an array of words parsed by spaces.
        let chunkLen = 0; // Initialize the length of a chunk to 0.
        let chunkArr = []; // Initialize the array storing the words contained in the chunk to be empty.
        const threadArr = []; // Initialize the array storing the chunk strings to be empty.
        let chunkStr = ''; // Initialize the chunk string to be empty.
        while (wordArr.length !== 0) {
          // Loop while there are still words in the array to chunk.
          if (chunkLen + wordArr[0].length <= 294) {
            // If adding the next word in the array to the chunk will not cause it to surpass the max length:
            chunkLen += wordArr[0].length + 1; // Increase the chunk length by the length of the word being added.
            chunkArr.push(wordArr.shift()); // Add the new word to the end of the chunk array, while also removing it from the front of the word array.
          } // If the max length is surpassed by adding the next word to the chunk:
          else {
            chunkStr = chunkArr.join(' '); // Turn the chunk into a string by delimiting the words with spaces.
            chunkArr = []; // Empty the chunk array.
            chunkLen = 0; // Reset the chunk length to 0.
            threadArr.push(chunkStr); // Add the chunk string to the thread array.
          }
        }
        chunkStr = chunkArr.join(' '); // Turn the last chunk into a string by delimiting the words with spaces.
        threadArr.push(chunkStr); // Add the last chunk string to the thread array.
        let isReply = false; // Create a boolean value to determine if we want to post a root post or a reply. Start with a root post.
        for (
          let j = 0;
          j < threadArr.length;
          j++ // Iterate over all of the chunk strings contained in the thread array.
        ) {
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
            ); // Post string j in the thread array.
          }
          if (isReply === false) {
            // If this post was posted as a root, meaning that this is the first iteration:
            isReply = true; // Set the boolean value to post as replies for the remaining iterations.
            mastUrlArr[i] = 'None!^&None!^&None!^&None';
            mastAltArr[i] = 'None!^&None!^&None!^&None';
          }
        }
      }
    }
    return; // Return void, we're done.
  }
}
