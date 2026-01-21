import express from "express";
import fetch from "node-fetch";
import cron from "node-cron";

const app = express();
app.use(express.json());

// 🔑 ENVIRONMENT VARIABLES
const BOT_TOKEN = process.env.BOT_TOKEN;
// Remove CHAT_ID - bot will work in any group

// 🎯 PRICE ALERT LIMITS (Per Group)
const groupAlerts = new Map(); // Store alerts per group: { groupId: { low: number, high: number } }

// 📦 PRICE CACHE
let cachedPrice = null;
let cacheTime = 0;
const CACHE_DURATION = 2 * 60 * 1000;

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

// 🌐 GET PRICE FROM DEXSCREENER
async function getDeepNodePrice() {
  const now = Date.now();
  
  if (cachedPrice && (now - cacheTime) < CACHE_DURATION) {
    console.log(`📦 Using cached price: $${cachedPrice}`);
    return cachedPrice;
  }
  
  console.log("🌐 Fetching DeepNode price from DexScreener...");
  
  try {
    const response = await fetch(
      "https://api.dexscreener.com/latest/dex/search?q=deepnode",
      {
        headers: { 'User-Agent': 'DeepNodeAlertBot/1.0' },
        timeout: 10000
      }
    );
    
    const data = await response.json();
    
    if (!data.pairs || data.pairs.length === 0) {
      console.log("❌ No DeepNode pairs found");
      return null;
    }
    
    const validPairs = data.pairs.filter(pair => 
      pair.priceUsd && parseFloat(pair.priceUsd) > 0
    );
    
    if (validPairs.length === 0) return null;
    
    validPairs.sort((a, b) => 
      (parseFloat(b.liquidity?.usd || 0) - parseFloat(a.liquidity?.usd || 0))
    );
    
    const price = parseFloat(validPairs[0].priceUsd);
    cachedPrice = price;
    cacheTime = now;
    
    return price;
    
  } catch (error) {
    console.error("❌ DexScreener error:", error.message);
    return null;
  }
}

// ⏰ CHECK PRICE FOR ALL GROUPS
cron.schedule("* * * * *", async () => {
  console.log(`🔔 Checking price for ${groupAlerts.size} groups...`);
  
  const currentPrice = await getDeepNodePrice();
  if (currentPrice === null) return;
  
  // Check alerts for each group
  for (const [groupId, alerts] of groupAlerts.entries()) {
    if (alerts.low && currentPrice <= alerts.low) {
      await sendTelegramMessage(
        groupId,
        `⚠️ <b>PRICE DROP ALERT</b>\n\n` +
        `DeepNode: <b>$${currentPrice.toFixed(6)}</b>\n` +
        `📉 <i>Below alert: $${alerts.low}</i>\n\n` +
        `Alert cleared. Set new with /setlow`
      );
      alerts.low = null;
    }
    
    if (alerts.high && currentPrice >= alerts.high) {
      await sendTelegramMessage(
        groupId,
        `🚀 <b>PRICE RISE ALERT</b>\n\n` +
        `DeepNode: <b>$${currentPrice.toFixed(6)}</b>\n` +
        `📈 <i>Above alert: $${alerts.high}</i>\n\n` +
        `Alert cleared. Set new with /sethigh`
      );
      alerts.high = null;
    }
  }
});

// 🤖 TELEGRAM COMMAND HANDLER (FOR ALL GROUPS)
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
    
    // Handle commands
    if (messageText === "/start") {
      await sendTelegramMessage(
        chatId,
        "🤖 <b>DeepNode Price Alert Bot</b>\n\n" +
        "I monitor DeepNode price 24/7 on all DEXes.\n\n" +
        "<b>Commands:</b>\n" +
        "/setlow [price]  - Alert when price drops\n" +
        "/sethigh [price] - Alert when price rises\n" +
        "/price           - Get current price\n" +
        "/status          - Check alerts\n" +
        "/clear           - Clear all alerts\n" +
        "/help            - Show help\n\n" +
        "💡 Works for everyone in this chat!"
      );
    }
    
    else if (messageText.startsWith("/setlow")) {
      const price = parseFloat(messageText.split(" ")[1]);
      if (isNaN(price) || price <= 0) {
        await sendTelegramMessage(chatId, "❌ Use: /setlow 0.035");
      } else {
        alerts.low = price;
        const currentPrice = await getDeepNodePrice();
        await sendTelegramMessage(
          chatId,
          `✅ <b>Low alert set at $${price}</b>\n\n` +
          `Current: <b>$${currentPrice?.toFixed(6) || 'Loading...'}</b>\n` +
          `I'll notify when price drops below $${price}`
        );
      }
    }
    
    else if (messageText.startsWith("/sethigh")) {
      const price = parseFloat(messageText.split(" ")[1]);
      if (isNaN(price) || price <= 0) {
        await sendTelegramMessage(chatId, "❌ Use: /sethigh 0.050");
      } else {
        alerts.high = price;
        const currentPrice = await getDeepNodePrice();
        await sendTelegramMessage(
          chatId,
          `✅ <b>High alert set at $${price}</b>\n\n` +
          `Current: <b>$${currentPrice?.toFixed(6) || 'Loading...'}</b>\n` +
          `I'll notify when price rises above $${price}`
        );
      }
    }
    
    else if (messageText === "/price") {
      const price = await getDeepNodePrice();
      if (price) {
        await sendTelegramMessage(
          chatId,
          `💰 <b>DeepNode Price:</b> $${price.toFixed(6)}\n\n` +
          `📡 Live from DexScreener`
        );
      } else {
        await sendTelegramMessage(chatId, "❌ Could not fetch price");
      }
    }
    
    else if (messageText === "/status") {
      const currentPrice = await getDeepNodePrice();
      const groupName = isGroup ? message.chat.title : "Your";
      
      await sendTelegramMessage(
        chatId,
        `📊 <b>${groupName} Alert Status</b>\n\n` +
        `Current price: <b>$${currentPrice?.toFixed(6) || 'Loading...'}</b>\n\n` +
        `Low alert: ${alerts.low ? `<b>$${alerts.low}</b>` : "❌ Not set"}\n` +
        `High alert: ${alerts.high ? `<b>$${alerts.high}</b>` : "❌ Not set"}\n\n` +
        `${isGroup ? '👥 Any member can set alerts' : '💬 Private alerts'}`
      );
    }
    
    else if (messageText === "/clear") {
      alerts.low = null;
      alerts.high = null;
      await sendTelegramMessage(chatId, "🗑️ <b>All alerts cleared!</b>\nSet new ones with /setlow or /sethigh");
    }
    
    else if (messageText === "/help") {
      await sendTelegramMessage(
        chatId,
        "🤖 <b>Help - DeepNode Alert Bot</b>\n\n" +
        "<b>How it works:</b>\n" +
        "• Checks DeepNode price every minute\n" +
        "• Alerts when price crosses your levels\n" +
        "• Works in groups & private chats\n\n" +
        "<b>Commands:</b>\n" +
        "/setlow 0.035  - Alert when ≤ $0.035\n" +
        "/sethigh 0.050 - Alert when ≥ $0.050\n" +
        "/price         - Current price\n" +
        "/status        - Check alerts\n" +
        "/clear         - Clear all alerts\n" +
        "/help          - This message\n\n" +
        "💡 <i>In groups, alerts work for everyone!</i>"
      );
    }
    
    else if (messageText.startsWith("/")) {
      await sendTelegramMessage(
        chatId,
        "❌ <b>Unknown command</b>\n\n" +
        "Try: /start, /setlow, /sethigh,\n" +
        "/price, /status, /clear, /help"
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
    service: "DeepNode Group Alert Bot",
    status: "🟢 RUNNING",
    groups: groupAlerts.size,
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// 🌐 START SERVER
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("=".repeat(50));
  console.log("🚀 DEEP NODE GROUP BOT STARTED");
  console.log("=".repeat(50));
  console.log(`📡 Port: ${PORT}`);
  console.log(`🤖 Bot Token: ${BOT_TOKEN ? '✅' : '❌'}`);
  console.log(`👥 Groups Supported: Unlimited`);
  console.log(`⏰ Check Interval: Every 1 minute`);
  console.log(`🔗 Webhook: /telegram`);
  console.log("=".repeat(50));
});