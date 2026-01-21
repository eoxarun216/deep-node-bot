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

// ✅ Check if environment variables are set
if (!BOT_TOKEN || !CHAT_ID) {
  console.error("❌ ERROR: BOT_TOKEN or CHAT_ID not set in environment variables!");
  console.error("Please set them in Render dashboard → Environment");
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
    if (!data.ok) {
      console.error("❌ Telegram API Error:", data);
    }
  } catch (error) {
    console.error("❌ Failed to send Telegram message:", error.message);
  }
}

// 📈 Get Deep Node Price from CoinGecko
async function getDeepNodePrice() {
  try {
    const response = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=deepbook&vs_currencies=usd"
    );
    
    if (!response.ok) {
      throw new Error(`CoinGecko API error: ${response.status}`);
    }
    
    const data = await response.json();
    
    if (!data.deepbook || !data.deepbook.usd) {
      throw new Error("Deep Node price not found in response");
    }
    
    return data.deepbook.usd;
  } catch (error) {
    console.error("❌ Error fetching price:", error.message);
    return null;
  }
}

// ⏰ Check Price Every 1 Minute
cron.schedule("* * * * *", async () => {
  console.log("🔍 Checking Deep Node price...");
  
  const currentPrice = await getDeepNodePrice();
  
  if (currentPrice === null) {
    console.log("⏭️ Skipping check due to API error");
    return;
  }
  
  console.log(`💰 Current Price: $${currentPrice}`);
  console.log(`📊 Low Alert: ${lowPriceAlert ? "$" + lowPriceAlert : "Not set"}`);
  console.log(`📈 High Alert: ${highPriceAlert ? "$" + highPriceAlert : "Not set"}`);
  
  // Check for low price alert
  if (lowPriceAlert && currentPrice <= lowPriceAlert) {
    await sendTelegramMessage(
      `⚠️ <b>PRICE DROP ALERT</b>\n\n` +
      `Deep Node price is now: <b>$${currentPrice}</b>\n` +
      `(Below your alert: $${lowPriceAlert})`
    );
    console.log(`📨 Sent low price alert at $${currentPrice}`);
    lowPriceAlert = null; // Reset after alert
  }
  
  // Check for high price alert
  if (highPriceAlert && currentPrice >= highPriceAlert) {
    await sendTelegramMessage(
      `🚀 <b>PRICE RISE ALERT</b>\n\n` +
      `Deep Node price is now: <b>$${currentPrice}</b>\n` +
      `(Above your alert: $${highPriceAlert})`
    );
    console.log(`📨 Sent high price alert at $${currentPrice}`);
    highPriceAlert = null; // Reset after alert
  }
});

// 🤖 Telegram Webhook Handler
app.post("/telegram", async (req, res) => {
  try {
    const messageText = req.body.message?.text;
    const chatId = req.body.message?.chat?.id;
    
    if (!messageText || chatId != CHAT_ID) {
      return res.sendStatus(200);
    }
    
    console.log(`📱 Received command: ${messageText}`);
    
    // Handle /start command
    if (messageText === "/start") {
      await sendTelegramMessage(
        "🤖 <b>Deep Node Price Alert Bot</b>\n\n" +
        "I will monitor Deep Node price 24/7 and alert you when it reaches your target prices.\n\n" +
        "<b>Available Commands:</b>\n" +
        "/setlow 0.035  - Alert when price drops BELOW this value\n" +
        "/sethigh 0.050 - Alert when price rises ABOVE this value\n" +
        "/status        - Check current alerts\n" +
        "/help          - Show this help message"
      );
    }
    
    // Handle /setlow command
    else if (messageText.startsWith("/setlow")) {
      const price = parseFloat(messageText.split(" ")[1]);
      if (isNaN(price) || price <= 0) {
        await sendTelegramMessage("❌ Please provide a valid price. Example: /setlow 0.035");
      } else {
        lowPriceAlert = price;
        await sendTelegramMessage(`✅ Low price alert set at <b>$${price}</b>\nI will notify you when price drops below this level.`);
      }
    }
    
    // Handle /sethigh command
    else if (messageText.startsWith("/sethigh")) {
      const price = parseFloat(messageText.split(" ")[1]);
      if (isNaN(price) || price <= 0) {
        await sendTelegramMessage("❌ Please provide a valid price. Example: /sethigh 0.050");
      } else {
        highPriceAlert = price;
        await sendTelegramMessage(`✅ High price alert set at <b>$${price}</b>\nI will notify you when price rises above this level.`);
      }
    }
    
    // Handle /status command
    else if (messageText === "/status") {
      const statusMessage = 
        `📊 <b>Current Alert Status</b>\n\n` +
        `Low Price Alert: ${lowPriceAlert ? "<b>$" + lowPriceAlert + "</b>" : "❌ Not set"}\n` +
        `High Price Alert: ${highPriceAlert ? "<b>$" + highPriceAlert + "</b>" : "❌ Not set"}\n\n` +
        `Use /setlow or /sethigh to set alerts.`;
      await sendTelegramMessage(statusMessage);
    }
    
    // Handle /help command
    else if (messageText === "/help") {
      await sendTelegramMessage(
        "🤖 <b>Help & Commands</b>\n\n" +
        "<b>Set Price Alerts:</b>\n" +
        "/setlow 0.035  - Alert when price ≤ $0.035\n" +
        "/sethigh 0.050 - Alert when price ≥ $0.050\n\n" +
        "<b>Other Commands:</b>\n" +
        "/status - Check current alerts\n" +
        "/help   - Show this message\n\n" +
        "💡 <i>Prices are in USD. Bot checks every minute.</i>"
      );
    }
    
    // Unknown command
    else if (messageText.startsWith("/")) {
      await sendTelegramMessage("❌ Unknown command. Use /help to see available commands.");
    }
    
  } catch (error) {
    console.error("❌ Error processing Telegram message:", error);
  }
  
  res.sendStatus(200);
});

// 🏠 Homepage (optional)
app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Deep Node Price Alert Bot</title>
      <style>
        body { font-family: Arial, sans-serif; max-width: 800px; margin: 40px auto; padding: 20px; }
        .container { background: #f5f5f5; padding: 30px; border-radius: 10px; }
        h1 { color: #333; }
        .status { background: white; padding: 15px; border-radius: 5px; margin: 20px 0; }
        .commands { background: #e8f4fc; padding: 20px; border-radius: 5px; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🤖 Deep Node Price Alert Bot</h1>
        <p>This bot is running 24/7 and monitoring Deep Node coin price.</p>
        
        <div class="status">
          <h3>📊 Bot Status: <span style="color: green;">🟢 RUNNING</span></h3>
          <p>Checks price every minute from CoinGecko API</p>
        </div>
        
        <div class="commands">
          <h3>📱 How to Use:</h3>
          <ol>
            <li>Open Telegram and find <b>@deepnode_alert_bot</b></li>
            <li>Send <code>/start</code> to begin</li>
            <li>Set alerts: <code>/setlow 0.035</code> or <code>/sethigh 0.050</code></li>
            <li>Wait for automatic alerts!</li>
          </ol>
        </div>
        
        <p><i>Last updated: ${new Date().toLocaleString()}</i></p>
      </div>
    </body>
    </html>
  `);
});

// 🌐 Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Bot server running on port ${PORT}`);
  console.log(`🔗 Webhook URL: http://localhost:${PORT}/telegram`);
  console.log(`🏠 Homepage: http://localhost:${PORT}`);
  console.log(`🤖 Bot Token: ${BOT_TOKEN ? '✅ Set' : '❌ Missing'}`);
  console.log(`💬 Chat ID: ${CHAT_ID ? '✅ Set' : '❌ Missing'}`);
  
  // Send startup notification
  sendTelegramMessage("🤖 <b>Deep Node Alert Bot Started Successfully!</b>\n\nBot is now monitoring prices 24/7. Use /help to see commands.");
});