import express from "express";
import fetch from "node-fetch";
import cron from "node-cron";

const app = express();
app.use(express.json());

// 🔑 ENVIRONMENT VARIABLES
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

// 🎯 PRICE ALERT LIMITS
let lowPriceAlert = null;
let highPriceAlert = null;

// 📦 PRICE CACHE
let cachedPrice = null;
let cacheTime = 0;
const CACHE_DURATION = 2 * 60 * 1000; // 2 minutes cache (DexScreener has no limits!)

// ✅ Check environment variables
if (!BOT_TOKEN || !CHAT_ID) {
  console.error("❌ ERROR: BOT_TOKEN or CHAT_ID not set!");
  process.exit(1);
}

// 📤 Send Telegram Message
async function sendTelegramMessage(text) {
  try {
    const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: text,
        parse_mode: "HTML",
        disable_web_page_preview: true
      })
    });
    
    const data = await response.json();
    return data.ok;
  } catch (error) {
    console.error("❌ Failed to send Telegram message:", error.message);
    return false;
  }
}

// 🌐 GET PRICE FROM DEXSCREENER (ONLY SOURCE - FREE & NO LIMITS)
async function getDeepNodePrice() {
  const now = Date.now();
  
  // Return cached price if valid (2 minutes)
  if (cachedPrice && (now - cacheTime) < CACHE_DURATION) {
    console.log(`📦 Using cached price: $${cachedPrice}`);
    return cachedPrice;
  }
  
  console.log("🌐 Fetching DeepNode price from DexScreener...");
  
  try {
    // Try multiple search terms to find the token
    const searchTerms = [
      'deepnode',
      'deep node',
      'deep-book',
      'deep book',
      'deepnode coin',
      'deep node coin'
    ];
    
    let bestPrice = null;
    let bestPairInfo = null;
    
    for (const term of searchTerms) {
      console.log(`🔍 Searching: "${term}"`);
      
      const response = await fetch(
        `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(term)}`,
        {
          headers: {
            'User-Agent': 'DeepNodeAlertBot/1.0',
            'Accept': 'application/json'
          },
          timeout: 10000
        }
      );
      
      if (!response.ok) {
        console.log(`⚠️ Search "${term}" failed: ${response.status}`);
        continue;
      }
      
      const data = await response.json();
      
      if (!data.pairs || data.pairs.length === 0) {
        console.log(`📭 No results for "${term}"`);
        continue;
      }
      
      console.log(`📊 Found ${data.pairs.length} pairs for "${term}"`);
      
      // Filter valid pairs with positive price and volume
      const validPairs = data.pairs.filter(pair => {
        if (!pair.priceUsd) return false;
        const price = parseFloat(pair.priceUsd);
        if (price <= 0 || price > 1000000) return false; // Sanity check
        
        // Check if it's likely DeepNode (name matching)
        const pairName = (pair.baseToken?.name || '').toLowerCase();
        const pairSymbol = (pair.baseToken?.symbol || '').toLowerCase();
        const searchTerm = term.toLowerCase();
        
        return pairName.includes(searchTerm.replace(/\s+/g, '')) ||
               pairSymbol.includes(searchTerm.replace(/\s+/g, '')) ||
               pairName.includes('deep') ||
               pairSymbol.includes('deep');
      });
      
      if (validPairs.length === 0) {
        console.log(`❌ No valid DeepNode pairs for "${term}"`);
        continue;
      }
      
      // Sort by liquidity (highest first)
      validPairs.sort((a, b) => {
        const liquidityA = parseFloat(a.liquidity?.usd || 0);
        const liquidityB = parseFloat(b.liquidity?.usd || 0);
        return liquidityB - liquidityA;
      });
      
      const bestPair = validPairs[0];
      const price = parseFloat(bestPair.priceUsd);
      
      // Update if this is the best price we've found
      if (!bestPrice || (bestPair.liquidity?.usd || 0) > (bestPairInfo?.liquidity?.usd || 0)) {
        bestPrice = price;
        bestPairInfo = {
          price: price,
          dex: bestPair.dexId,
          pair: bestPair.pairAddress,
          liquidity: parseFloat(bestPair.liquidity?.usd || 0).toFixed(2),
          volume24h: parseFloat(bestPair.volume?.h24 || 0).toFixed(2),
          chain: bestPair.chainId,
          url: `https://dexscreener.com/${bestPair.chainId}/${bestPair.pairAddress}`
        };
      }
      
      console.log(`✅ Found: $${price} on ${bestPair.dexId}`);
    }
    
    if (bestPrice && bestPairInfo) {
      console.log(`🎯 Selected best price: $${bestPrice}`);
      console.log(`   DEX: ${bestPairInfo.dex}`);
      console.log(`   Chain: ${bestPairInfo.chain}`);
      console.log(`   Liquidity: $${bestPairInfo.liquidity}`);
      console.log(`   Volume 24h: $${bestPairInfo.volume24h}`);
      console.log(`   Chart: ${bestPairInfo.url}`);
      
      // Update cache
      cachedPrice = bestPrice;
      cacheTime = now;
      
      return bestPrice;
    }
    
    console.log("❌ Could not find DeepNode price on any DEX");
    return null;
    
  } catch (error) {
    console.error("❌ DexScreener API error:", error.message);
    return null;
  }
}

// ⏰ CHECK PRICE EVERY 1 MINUTE (DexScreener has no rate limits!)
cron.schedule("* * * * *", async () => {
  console.log("🔔 Price check cycle started");
  
  const currentPrice = await getDeepNodePrice();
  
  if (currentPrice === null) {
    console.log("⏭️ Skipping alert check - no price data");
    return;
  }
  
  console.log(`💰 Current Price: $${currentPrice}`);
  console.log(`📊 Low Alert: ${lowPriceAlert ? "$" + lowPriceAlert : "Not set"}`);
  console.log(`📈 High Alert: ${highPriceAlert ? "$" + highPriceAlert : "Not set"}`);
  
  // Check low price alert
  if (lowPriceAlert && currentPrice <= lowPriceAlert) {
    const success = await sendTelegramMessage(
      `⚠️ <b>PRICE DROP ALERT</b>\n\n` +
      `Deep Node price is now: <b>$${currentPrice.toFixed(6)}</b>\n` +
      `📉 <i>Below your alert: $${lowPriceAlert}</i>\n\n` +
      `🔄 Alert will auto-reset. Set new with /setlow`
    );
    
    if (success) {
      console.log(`📨 Sent low price alert at $${currentPrice}`);
      lowPriceAlert = null;
    }
  }
  
  // Check high price alert
  if (highPriceAlert && currentPrice >= highPriceAlert) {
    const success = await sendTelegramMessage(
      `🚀 <b>PRICE RISE ALERT</b>\n\n` +
      `Deep Node price is now: <b>$${currentPrice.toFixed(6)}</b>\n` +
      `📈 <i>Above your alert: $${highPriceAlert}</i>\n\n` +
      `🔄 Alert will auto-reset. Set new with /sethigh`
    );
    
    if (success) {
      console.log(`📨 Sent high price alert at $${currentPrice}`);
      highPriceAlert = null;
    }
  }
});

// 🤖 TELEGRAM COMMAND HANDLER
app.post("/telegram", async (req, res) => {
  try {
    const messageText = req.body.message?.text;
    const chatId = req.body.message?.chat?.id;
    
    // Only respond to authorized chat
    if (!messageText || chatId.toString() !== CHAT_ID.toString()) {
      return res.sendStatus(200);
    }
    
    console.log(`📱 Received command: ${messageText}`);
    
    // Handle /start command
    if (messageText === "/start") {
      await sendTelegramMessage(
        "🤖 <b>Deep Node Price Alert Bot</b>\n\n" +
        "I monitor DeepNode price 24/7 using DexScreener API.\n\n" +
        "<b>Commands:</b>\n" +
        "/setlow [price]  - Alert when price drops BELOW\n" +
        "/sethigh [price] - Alert when price rises ABOVE\n" +
        "/price           - Get current price\n" +
        "/status          - Check current alerts\n" +
        "/help            - Show help\n\n" +
        "💡 <i>Example: /setlow 0.035</i>"
      );
    }
    
    // Handle /setlow command
    else if (messageText.startsWith("/setlow")) {
      const price = parseFloat(messageText.split(" ")[1]);
      if (isNaN(price) || price <= 0) {
        await sendTelegramMessage("❌ Please provide a valid price. Example: /setlow 0.035");
      } else {
        lowPriceAlert = price;
        const currentPrice = await getDeepNodePrice();
        await sendTelegramMessage(
          `✅ <b>Low price alert set at $${price}</b>\n\n` +
          `Current price: <b>$${currentPrice?.toFixed(6) || 'Loading...'}</b>\n` +
          `I will notify you when price drops below $${price}`
        );
      }
    }
    
    // Handle /sethigh command
    else if (messageText.startsWith("/sethigh")) {
      const price = parseFloat(messageText.split(" ")[1]);
      if (isNaN(price) || price <= 0) {
        await sendTelegramMessage("❌ Please provide a valid price. Example: /sethigh 0.050");
      } else {
        highPriceAlert = price;
        const currentPrice = await getDeepNodePrice();
        await sendTelegramMessage(
          `✅ <b>High price alert set at $${price}</b>\n\n` +
          `Current price: <b>$${currentPrice?.toFixed(6) || 'Loading...'}</b>\n` +
          `I will notify you when price rises above $${price}`
        );
      }
    }
    
    // Handle /price command
    else if (messageText === "/price") {
      const price = await getDeepNodePrice();
      if (price) {
        await sendTelegramMessage(
          `💰 <b>Current DeepNode Price:</b> $${price.toFixed(6)}\n\n` +
          `📊 <i>Updated just now from DexScreener</i>`
        );
      } else {
        await sendTelegramMessage(
          "❌ <b>Could not fetch price</b>\n\n" +
          "DeepNode might not be trading on any DEX yet.\n" +
          "Try again in a few minutes."
        );
      }
    }
    
    // Handle /status command
    else if (messageText === "/status") {
      const currentPrice = await getDeepNodePrice();
      await sendTelegramMessage(
        `📊 <b>DeepNode Alert Status</b>\n\n` +
        `Current price: <b>$${currentPrice?.toFixed(6) || 'Loading...'}</b>\n\n` +
        `Low price alert: ${lowPriceAlert ? `<b>$${lowPriceAlert}</b>` : "❌ Not set"}\n` +
        `High price alert: ${highPriceAlert ? `<b>$${highPriceAlert}</b>` : "❌ Not set"}\n\n` +
        `💡 Use /setlow or /sethigh to set alerts`
      );
    }
    
    // Handle /help command
    else if (messageText === "/help") {
      await sendTelegramMessage(
        "🤖 <b>DeepNode Price Alert Bot Help</b>\n\n" +
        "<b>How it works:</b>\n" +
        "• Checks price every minute from DexScreener\n" +
        "• Alerts when price crosses your set levels\n" +
        "• Alerts auto-reset after triggering\n\n" +
        "<b>Commands:</b>\n" +
        "/setlow 0.035  - Alert when ≤ $0.035\n" +
        "/sethigh 0.050 - Alert when ≥ $0.050\n" +
        "/price         - Get current price\n" +
        "/status        - Check alerts\n" +
        "/help          - This message\n\n" +
        "💡 <i>No rate limits! Powered by DexScreener API</i>"
      );
    }
    
    // Handle /info command
    else if (messageText === "/info") {
      await sendTelegramMessage(
        "📡 <b>Bot Information</b>\n\n" +
        "• Source: DexScreener API\n" +
        "• Updates: Every 1 minute\n" +
        "• Cache: 2 minutes\n" +
        "• Status: ✅ Active 24/7\n\n" +
        "🔗 <i>Powered by Render.com + Telegram Bot API</i>"
      );
    }
    
    // Unknown command
    else if (messageText.startsWith("/")) {
      await sendTelegramMessage(
        "❌ <b>Unknown command</b>\n\n" +
        "Available commands:\n" +
        "/start, /setlow, /sethigh,\n" +
        "/price, /status, /help, /info\n\n" +
        "💡 Type /help for details"
      );
    }
    
  } catch (error) {
    console.error("❌ Error processing Telegram message:", error);
  }
  
  res.sendStatus(200);
});

// 🏠 HOMEPAGE
app.get("/", (req, res) => {
  const status = {
    service: "DeepNode Price Alert Bot",
    status: "🟢 RUNNING",
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    node: process.version,
    timestamp: new Date().toISOString()
  };
  
  res.json(status);
});

// 🩺 HEALTH CHECK
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    service: "deep-node-bot",
    timestamp: new Date().toISOString(),
    checks: {
      bot_token: !!BOT_TOKEN,
      chat_id: !!CHAT_ID,
      cache_age: cachedPrice ? Date.now() - cacheTime : null
    }
  });
});

// 🌐 START SERVER
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("=".repeat(50));
  console.log("🚀 DEEP NODE PRICE ALERT BOT STARTED");
  console.log("=".repeat(50));
  console.log(`📡 Port: ${PORT}`);
  console.log(`🤖 Bot Token: ${BOT_TOKEN ? '✅ Set' : '❌ Missing'}`);
  console.log(`💬 Chat ID: ${CHAT_ID ? '✅ Set' : '❌ Missing'}`);
  console.log(`⏰ Check Interval: Every 1 minute`);
  console.log(`📦 Cache Duration: 2 minutes`);
  console.log(`🌐 API Source: DexScreener (Free, No Limits)`);
  console.log(`🔗 Webhook: /telegram`);
  console.log(`🏠 Homepage: /`);
  console.log(`🩺 Health: /health`);
  console.log("=".repeat(50));
  
  // Send startup notification
  sendTelegramMessage(
    "🤖 <b>DeepNode Alert Bot Restarted</b>\n\n" +
    "✅ <i>Now using DexScreener API (No rate limits!)</i>\n\n" +
    "Type /help to see available commands."
  );
});