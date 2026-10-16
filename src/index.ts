import Bot from './lib/bot.ts';
import getPostText from './lib/getPostText.ts';

await Bot.run(getPostText); // Run the bot, supplying it the getPostText function from getPostText.ts.
console.log(`[${new Date().toISOString()}] Posts complete!`); // Write to the console, saying that the posting operation is complete.
