import Bot from './lib/bot.ts';

await Bot.run();

console.log(`[${new Date().toISOString()}] Posts complete!`);
