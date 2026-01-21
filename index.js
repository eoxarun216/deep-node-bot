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
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

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
        parse_mode: "HTML"
      })
    });
    
    const data = await response.json();
    return data.ok;
  } catch (error) {
    console.error("❌ Failed to send Telegram message:", error.message);
    return false;
  }
}

// 📈 Get Price from CoinGecko
async function getPriceFromCoinGecko() {
  try {
    // Add headers to identify your app
    const response = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=deepbook&vs_currencies=usd",
      {
        headers: {
          'User-Agent': 'DeepNodeAlertBot/1.0',
          'Accept': 'application/json'
        }
      }
    );
    
    if (response.status === 429) {
      console.warn("⚠️ CoinGecko rate limit hit. Using cache or waiting...");
      return null;
    }
    
    if (!response.ok) {
      throw new Error(`CoinGecko API error: ${response.status}`);
    }
    
    const data = await response.json();
    
    if (!data.deepbook?.usd) {
      throw new Error("Deep Node price not found");
    }
    
    return data.deepbook.usd;
  } catch (error) {
    console.error("❌ CoinGecko error:", error.message);
    return null;
  }
}

// 🌐 Get Price from Alternative Source (DEX)
async function getPriceFromDex() {
  try {
    // Example: Using a DEX API or alternative
    const response = await fetch(
      "https://api.dexscreener.com/latest/dex/search?q=deepbook"
    );
    
    const data = await response.json();
    
    if (data.pairs && data.pairs.length > 0) {
      return data.pairs[0].priceUsd;
    }
    
    return null;
  } catch (error) {
    console.error("❌ DEX API error:", error.message);
    return null;
  }
}

// 💰 Get Price with Fallback & Cache
async function getDeepNodePrice() {
  const now = Date.now();
  
  // Return cached price if valid
  if (cachedPrice && (now - cacheTime) < CACHE_DURATION) {
    console.log("📦 Using cached price");
    return cachedPrice;
  }
  
  console.log("🌐 Fetching fresh price...");
  
  // Try CoinGecko first
  let price = await getPriceFromCoinGecko();
  
  // If rate limited, try alternative
  if (price === null) {
    console.log("🔄 Trying alternative price source...");
    price = await getPriceFromDex();
  }
  
  // Update cache if we got a price
  if (price !== null) {
    cachedPrice = price;
    cacheTime = now;
  }
  
  return price;
}

// ⏰ CHECK PRICE EVERY 5 MINUTES (to avoid rate limits)
cron.schedule("*/5 * * * *", async () => {
  console.log("🔍 Checking Deep Node price...");
  
  // Add random delay to avoid hitting API at same time
  const randomDelay = Math.random() * 2000; // 0-2 seconds
  await new Promise(resolve => setTimeout(resolve, randomDelay));
  
  const currentPrice = await getDeepNodePrice();
  
  if (currentPrice === null) {
    console.log("⏭️ Skipping due to API limits");
    return;
  }
  
  console.log(`💰 Current Price: $${currentPrice}`);
  console.log(`📊 Low Alert: ${lowPriceAlert ? "$" + lowPriceAlert : "Not set"}`);
  console.log(`📈 High Alert: ${highPriceAlert ? "$" + highPriceAlert : "Not set"}`);
  
  // Check low price alert
  if (lowPriceAlert && currentPrice <= lowPriceAlert) {
    const success = await sendTelegramMessage(
      `⚠️ <b>PRICE DROP ALERT</b>\n\n` +
      `Deep Node price: <b>$${currentPrice}</b>\n` +
      `(Below: $${lowPriceAlert})\n\n` +
      `<i>Alert will reset. Set new alert with /setlow</i>`
    );
    
    if (success) {
      console.log(`📨 Sent low alert at $${currentPrice}`);
      lowPriceAlert = null;
    }
  }
  
  // Check high price alert
  if (highPriceAlert && currentPrice >= highPriceAlert) {
    const success = await sendTelegramMessage(
      `🚀 <b>PRICE RISE ALERT</b>\n\n` +
      `Deep Node price: <b>$${currentPrice}</b>\n` +
      `(Above: $${highPriceAlert})\n\n` +
      `<i>Alert will reset. Set new alert with /sethigh</i>`
    );
    
    if (success) {
      console.log(`📨 Sent high alert at $${currentPrice}`);
      highPriceAlert = null;
    }
  }
});

// 🤖 TELEGRAM COMMANDS (keep your existing webhook code)
app.post("/telegram", async (req, res) => {
  // Your existing command handler...
});

// Add a /price command
app.post("/telegram", async (req, res) => {
  const messageText = req.body.message?.text;
  const chatId = req.body.message?.chat?.id;
  
  if (!messageText || chatId != CHAT_ID) {
    return res.sendStatus(200);
  }
  
  // Add /price command
  if (messageText === "/price") {
    const price = await getDeepNodePrice();
    if (price) {
      await sendTelegramMessage(`💰 Current Deep Node Price: <b>$${price}</b>`);
    } else {
      await sendTelegramMessage("❌ Could not fetch price. API limits may be hit.");
    }
  }
  
  // Your other command handlers...
  res.sendStatus(200);
});

// 🌐 Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Bot running on port ${PORT}`);
  console.log(`⏱️  Price checks every 5 minutes`);
  console.log(`📦 Using cache: ${CACHE_DURATION/1000} seconds`);
});