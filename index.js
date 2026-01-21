import express from "express";
import fetch from "node-fetch";
import cron from "node-cron";

const app = express();
app.use(express.json());

// 🔑 ENVIRONMENT VARIABLES
const BOT_TOKEN = process.env.BOT_TOKEN;

// 🎯 PRICE ALERT LIMITS (Per Group)
const groupAlerts = new Map();

// 📦 PRICE CACHE
let cachedPrice = null;
let cacheTime = 0;
let cachedINRRate = null;
let inrCacheTime = 0;
const CACHE_DURATION = 2 * 60 * 1000; // 2 minutes
const INR_CACHE_DURATION = 30 * 60 * 1000; // 30 minutes for INR rate

// ✅ Check environment variables
if (!BOT_TOKEN) {
  console.error("❌ ERROR: BOT_TOKEN not set!");
  process.exit(1);
}

// 📤 Send Telegram Message to Specific Chat
async function sendTelegramMessage(chatId, text) {
  try {
    const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: "HTML",
        disable_web_page_preview: true
      })
    });
    
    const data = await response.json();
    return data.ok;
  } catch (error) {
    console.error(`❌ Failed to send to ${chatId}:`, error.message);
    return false;
  }
}

// 💱 GET USD TO INR CONVERSION RATE
async function getUSDToINR() {
  const now = Date.now();
  
  if (cachedINRRate && (now - inrCacheTime) < INR_CACHE_DURATION) {
    console.log(`💰 Using cached INR rate: ₹${cachedINRRate}`);
    return cachedINRRate;
  }
  
  console.log("💱 Fetching USD to INR conversion rate...");
  
  try {
    // Using Free Currency API (multiple fallbacks)
    const apis = [
      "https://api.exchangerate-api.com/v4/latest/USD",
      "https://api.frankfurter.app/latest?from=USD",
      "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json"
    ];
    
    for (const api of apis) {
      try {
        const response = await fetch(api, { timeout: 5000 });
        const data = await response.json();
        
        let rate = null;
        
        if (api.includes("exchangerate-api") && data.rates?.INR) {
          rate = data.rates.INR;
        } else if (api.includes("frankfurter") && data.rates?.INR) {
          rate = data.rates.INR;
        } else if (api.includes("currency-api") && data.usd?.inr) {
          rate = data.usd.inr;
        }
        
        if (rate && rate > 0) {
          cachedINRRate = parseFloat(rate);
          inrCacheTime = now;
          console.log(`✅ INR rate updated: ₹${cachedINRRate} (from ${api.split('/')[2]})`);
          return cachedINRRate;
        }
      } catch (error) {
        console.log(`⏭️ API failed: ${api.split('/')[2]}`);
      }
    }
    
    // If all APIs fail, use fixed rate as fallback
    console.log("⚠️ Using fallback INR rate: 83.0");
    cachedINRRate = 83.0;
    inrCacheTime = now;
    return cachedINRRate;
    
  } catch (error) {
    console.error("❌ Error fetching INR rate:", error.message);
    return 83.0; // Fallback rate
  }
}

// 🌐 GET PRICE FROM DEXSCREENER
async function getDeepNodePrice() {
  const now = Date.now();
  
  if (cachedPrice && (now - cacheTime) < CACHE_DURATION) {
    console.log(`📦 Using cached price: $${cachedPrice}`);
    return cachedPrice;
  }
  
  console.log("🌐 Fetching DeepNode price from DexScreener...");
  
  try {
    // Try multiple search terms
    const searchTerms = ['deepnode', 'deep node', 'deep-book', 'deep book'];
    
    for (const term of searchTerms) {
      try {
        const response = await fetch(
          `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(term)}`,
          { timeout: 8000 }
        );
        
        if (!response.ok) continue;
        
        const data = await response.json();
        
        if (!data.pairs || data.pairs.length === 0) continue;
        
        // Find valid pair with price
        const validPair = data.pairs.find(p => 
          p.priceUsd && parseFloat(p.priceUsd) > 0
        );
        
        if (validPair) {
          const price = parseFloat(validPair.priceUsd);
          console.log(`✅ Found via "${term}": $${price} on ${validPair.dexId}`);
          
          cachedPrice = price;
          cacheTime = now;
          return price;
        }
      } catch (error) {
        // Try next term
      }
    }
    
    console.log("❌ Could not fetch DeepNode price");
    return null;
    
  } catch (error) {
    console.error("❌ DexScreener error:", error.message);
    return null;
  }
}

// 💰 GET PRICE IN BOTH USD & INR
async function getPriceWithINR() {
  const usdPrice = await getDeepNodePrice();
  const inrRate = await getUSDToINR();
  
  if (usdPrice === null) {
    return { usd: null, inr: null, rate: inrRate };
  }
  
  const inrPrice = usdPrice * inrRate;
  
  return {
    usd: usdPrice,
    inr: inrPrice,
    rate: inrRate
  };
}

// ⏰ CHECK PRICE FOR ALL GROUPS
cron.schedule("* * * * *", async () => {
  console.log(`🔔 Checking price for ${groupAlerts.size} groups...`);
  
  const priceData = await getPriceWithINR();
  if (priceData.usd === null) return;
  
  // Check alerts for each group
  for (const [groupId, alerts] of groupAlerts.entries()) {
    if (alerts.low && priceData.usd <= alerts.low) {
      await sendTelegramMessage(
        groupId,
        `⚠️ <b>PRICE DROP ALERT</b>\n\n` +
        `DeepNode Price:\n` +
        `• <b>$${priceData.usd.toFixed(6)}</b> (USD)\n` +
        `• <b>₹${priceData.inr.toFixed(2)}</b> (INR)\n\n` +
        `📉 <i>Below your alert: $${alerts.low}</i>\n` +
        `🔄 Alert cleared. Set new with /setlow`
      );
      alerts.low = null;
    }
    
    if (alerts.high && priceData.usd >= alerts.high) {
      await sendTelegramMessage(
        groupId,
        `🚀 <b>PRICE RISE ALERT</b>\n\n` +
        `DeepNode Price:\n` +
        `• <b>$${priceData.usd.toFixed(6)}</b> (USD)\n` +
        `• <b>₹${priceData.inr.toFixed(2)}</b> (INR)\n\n` +
        `📈 <i>Above your alert: $${alerts.high}</i>\n` +
        `🔄 Alert cleared. Set new with /sethigh`
      );
      alerts.high = null;
    }
  }
});

// 🤖 TELEGRAM COMMAND HANDLER
app.post("/telegram", async (req, res) => {
  try {
    const message = req.body.message;
    if (!message) return res.sendStatus(200);
    
    const chatId = message.chat.id;
    const messageText = message.text;
    const isGroup = message.chat.type === "group" || message.chat.type === "supergroup";
    
    if (!messageText) return res.sendStatus(200);
    
    console.log(`📱 ${isGroup ? 'Group' : 'Private'} ${chatId}: ${messageText}`);
    
    // Initialize group alerts if not exists
    if (!groupAlerts.has(chatId)) {
      groupAlerts.set(chatId, { low: null, high: null });
    }
    
    const alerts = groupAlerts.get(chatId);
    
    // Handle /start command
    if (messageText === "/start") {
      await sendTelegramMessage(
        chatId,
        "🤖 <b>DeepNode Price Alert Bot</b>\n\n" +
        "I monitor DeepNode price 24/7 on all DEXes.\n" +
        "<i>Now showing prices in USD & INR ₹</i>\n\n" +
        "<b>Commands:</b>\n" +
        "/setlow [price]  - Alert when price drops\n" +
        "/sethigh [price] - Alert when price rises\n" +
        "/price           - Get current price (USD+INR)\n" +
        "/status          - Check alerts\n" +
        "/clear           - Clear all alerts\n" +
        "/inrrate         - Show USD to INR rate\n" +
        "/help            - Show help\n\n" +
        "💡 Works for everyone in this chat!"
      );
    }
    
    // Handle /setlow command
    else if (messageText.startsWith("/setlow")) {
      const price = parseFloat(messageText.split(" ")[1]);
      if (isNaN(price) || price <= 0) {
        await sendTelegramMessage(chatId, "❌ Use: /setlow 0.035");
      } else {
        alerts.low = price;
        const priceData = await getPriceWithINR();
        const inrValue = price * (priceData.rate || 83);
        
        await sendTelegramMessage(
          chatId,
          `✅ <b>Low price alert set at $${price}</b>\n\n` +
          `Current price:\n` +
          `• <b>$${priceData.usd?.toFixed(6) || 'Loading...'}</b> (USD)\n` +
          `• <b>₹${priceData.inr?.toFixed(2) || 'Loading...'}</b> (INR)\n\n` +
          `Alert value in INR: <b>₹${inrValue.toFixed(2)}</b>\n` +
          `I'll notify when price drops below $${price}`
        );
      }
    }
    
    // Handle /sethigh command
    else if (messageText.startsWith("/sethigh")) {
      const price = parseFloat(messageText.split(" ")[1]);
      if (isNaN(price) || price <= 0) {
        await sendTelegramMessage(chatId, "❌ Use: /sethigh 0.050");
      } else {
        alerts.high = price;
        const priceData = await getPriceWithINR();
        const inrValue = price * (priceData.rate || 83);
        
        await sendTelegramMessage(
          chatId,
          `✅ <b>High price alert set at $${price}</b>\n\n` +
          `Current price:\n` +
          `• <b>$${priceData.usd?.toFixed(6) || 'Loading...'}</b> (USD)\n` +
          `• <b>₹${priceData.inr?.toFixed(2) || 'Loading...'}</b> (INR)\n\n` +
          `Alert value in INR: <b>₹${inrValue.toFixed(2)}</b>\n` +
          `I'll notify when price rises above $${price}`
        );
      }
    }
    
    // Handle /price command
    else if (messageText === "/price") {
      const priceData = await getPriceWithINR();
      
      if (priceData.usd) {
        await sendTelegramMessage(
          chatId,
          `💰 <b>Current DeepNode Price</b>\n\n` +
          `USD: <b>$${priceData.usd.toFixed(6)}</b>\n` +
          `INR: <b>₹${priceData.inr.toFixed(2)}</b>\n\n` +
          `💱 Exchange Rate: $1 = ₹${priceData.rate.toFixed(2)}\n` +
          `📡 Live from DexScreener`
        );
      } else {
        await sendTelegramMessage(chatId, "❌ Could not fetch price");
      }
    }
    
    // Handle /status command
    else if (messageText === "/status") {
      const priceData = await getPriceWithINR();
      const groupName = isGroup ? message.chat.title : "Your";
      
      let statusText = `📊 <b>${groupName} Alert Status</b>\n\n`;
      
      if (priceData.usd) {
        statusText += `Current price:\n` +
          `• <b>$${priceData.usd.toFixed(6)}</b> (USD)\n` +
          `• <b>₹${priceData.inr.toFixed(2)}</b> (INR)\n\n`;
      } else {
        statusText += `Current price: <i>Loading...</i>\n\n`;
      }
      
      // Show low alert with INR value
      if (alerts.low) {
        const inrValue = alerts.low * (priceData.rate || 83);
        statusText += `Low alert: <b>$${alerts.low}</b> (≈ ₹${inrValue.toFixed(2)})\n`;
      } else {
        statusText += `Low alert: ❌ Not set\n`;
      }
      
      // Show high alert with INR value
      if (alerts.high) {
        const inrValue = alerts.high * (priceData.rate || 83);
        statusText += `High alert: <b>$${alerts.high}</b> (≈ ₹${inrValue.toFixed(2)})\n`;
      } else {
        statusText += `High alert: ❌ Not set\n`;
      }
      
      statusText += `\n💡 Use /setlow or /sethigh to set alerts`;
      
      await sendTelegramMessage(chatId, statusText);
    }
    
    // Handle /inrrate command
    else if (messageText === "/inrrate") {
      const inrRate = await getUSDToINR();
      await sendTelegramMessage(
        chatId,
        `💱 <b>USD to INR Exchange Rate</b>\n\n` +
        `Current rate: <b>$1 = ₹${inrRate.toFixed(2)}</b>\n\n` +
        `💡 This rate updates every 30 minutes.\n` +
        `Used for all USD → INR conversions.`
      );
    }
    
    // Handle /clear command
    else if (messageText === "/clear") {
      alerts.low = null;
      alerts.high = null;
      await sendTelegramMessage(chatId, "🗑️ <b>All alerts cleared!</b>\nSet new ones with /setlow or /sethigh");
    }
    
    // Handle /help command
    else if (messageText === "/help") {
      await sendTelegramMessage(
        chatId,
        "🤖 <b>Help - DeepNode Alert Bot</b>\n\n" +
        "<b>Features:</b>\n" +
        "• Shows prices in USD & INR ₹\n" +
        "• Checks price every minute\n" +
        "• Works in groups & private chats\n\n" +
        "<b>Commands:</b>\n" +
        "/setlow 0.035  - Alert when ≤ $0.035\n" +
        "/sethigh 0.050 - Alert when ≥ $0.050\n" +
        "/price         - Current price (USD+INR)\n" +
        "/status        - Check alerts\n" +
        "/inrrate       - USD to INR rate\n" +
        "/clear         - Clear all alerts\n" +
        "/help          - This message\n\n" +
        "💡 <i>Alerts in USD, shown in both USD & INR</i>"
      );
    }
    
    // Unknown command
    else if (messageText.startsWith("/")) {
      await sendTelegramMessage(
        chatId,
        "❌ <b>Unknown command</b>\n\n" +
        "Try: /start, /setlow, /sethigh,\n" +
        "/price, /status, /inrrate, /clear, /help"
      );
    }
    
  } catch (error) {
    console.error("❌ Telegram handler error:", error);
  }
  
  res.sendStatus(200);
});

// 🏠 HOMEPAGE
app.get("/", (req, res) => {
  res.json({
    service: "DeepNode Alert Bot (USD+INR)",
    status: "🟢 RUNNING",
    groups: groupAlerts.size,
    usd_to_inr: cachedINRRate || "Loading...",
    timestamp: new Date().toISOString()
  });
});

// 🌐 START SERVER
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("=".repeat(50));
  console.log("🚀 DEEP NODE BOT WITH INR SUPPORT");
  console.log("=".repeat(50));
  console.log(`📡 Port: ${PORT}`);
  console.log(`🤖 Bot Token: ${BOT_TOKEN ? '✅' : '❌'}`);
  console.log(`👥 Groups Supported: Unlimited`);
  console.log(`💰 INR Support: Enabled`);
  console.log(`⏰ Check Interval: Every 1 minute`);
  console.log(`🔗 Webhook: /telegram`);
  console.log("=".repeat(50));
  
  // Fetch initial INR rate
  getUSDToINR().then(rate => {
    console.log(`💱 Initial INR Rate: ₹${rate}`);
  });
});