import Bot from './lib/bot.ts';
import getPostText from './lib/getPostText.ts';

await Bot.run(getPostText);
console.log(`[${new Date().toISOString()}] Posts complete!`);
