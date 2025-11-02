require("dotenv").config();
const express = require("express");
const fetch = require("node-fetch");
const { createClient } = require("@supabase/supabase-js");
const bodyParser = require("body-parser");
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const { fork, spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY || "");
const app = express();
const PORT = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;

const algorithm = "aes-256-gcm";
const ENC_KEY = crypto.scryptSync(process.env.JWT_SECRET || "secret", "salt", 32);
const IV_LEN = 12;
const processes = {};
const logs = {};

function encrypt(text) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(algorithm, ENC_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

function decrypt(data) {
  const buf = Buffer.from(data, "base64");
  const iv = buf.slice(0, IV_LEN);
  const tag = buf.slice(IV_LEN, IV_LEN + 16);
  const encrypted = buf.slice(IV_LEN + 16);
  const decipher = crypto.createDecipheriv(algorithm, ENC_KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

app.use("/assets", express.static(path.join(__dirname, "public", "assets")));
app.use(express.static("public"));
app.use(bodyParser.json({ limit: "10mb" }));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "login.html")));
const vpnCache = new Map();

function isPrivateIP(ip) {
  return (
    ip === "127.0.0.1" ||
    ip === "::1" ||
    ip.startsWith("10.") ||
    ip.startsWith("192.168.") ||
    ip.startsWith("172.") // covers 172.16.0.0 – 172.31.255.255
  );
}

app.use(async (req, res, next) => {
  let ip =
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket.remoteAddress ||
    "unknown";

  // Normalize IPv6 mapped addresses (e.g. ::ffff:10.0.0.1 → 10.0.0.1)
  if (ip.startsWith("::ffff:")) ip = ip.replace("::ffff:", "");

  // Skip localhost & private networks
  if (isPrivateIP(ip)) return next();

  // ✅ Check cache first
  if (vpnCache.has(ip)) {
    const cached = vpnCache.get(ip);

    // Check expiry
    if (cached.expires > Date.now()) {
      if (cached.block === true) {
        return res.status(403).send("Access denied: VPN/proxy detected.");
      } else {
        return next();
      }
    } else {
      // Cache expired — remove it
      vpnCache.delete(ip);
    }
  }

  // ✅ Fetch fresh data from ipapi.is
  try {
    const resp = await fetch(`https://api.ipapi.is/?ip=${ip}`);
    const data = await resp.json();

    const isBad =
      data.is_vpn === true ||
      data.is_proxy === true ||
      data.is_datacenter === true;

    // ✅ Cache result for 1 hour
    vpnCache.set(ip, {
      block: isBad,
      expires: Date.now() + 3600 * 1000 // 1 hour
    });

    if (isBad) {
      return res.status(403).send("Access denied: VPN/proxy detected.");
    }

  } catch (err) {
    console.warn("VPN API error:", err);
    // Fail open (allow access)
  }

  next();
});
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of vpnCache.entries()) {
    if (entry.expires < now) vpnCache.delete(ip);
  }
}, 60000);
app.post("/api/user-sync", async (req, res) => {
  try {
    const { id, username, avatar_url } = req.body;

    const { data: existing, error: fetchError } = await supabase
      .from("users")
      .select("account_standing, ban_reason")
      .eq("id", id)
      .single();

    if (fetchError && fetchError.code !== "PGRST116") {
      console.error(fetchError);
      return res.status(500).json({ error: "Database error." });
    }

    if (existing && existing.account_standing === "disabled") {
      return res.status(403).json({
        error: "Access disabled",
        reason: existing.ban_reason || "No reason provided.",
      });
    }

    const { error: upsertError } = await supabase
      .from("users")
      .upsert(
        {
          id,
          username,
          avatar_url,
          account_standing: existing?.account_standing || "enabled",
          updated_at: new Date().toISOString(),
        },
        { onConflict: "id" }
      );

    if (upsertError) throw upsertError;

    return res.json({ success: true });
  } catch (e) {
    console.error("User sync failed:", e);
    return res.status(500).json({ error: e.message || "Internal error" });
  }
});


app.post("/api/add-bot", async (req, res) => {
  try {
    const { user_id, token, language, name } = req.body;
    if (!user_id || !token || !language) return res.status(400).json({ error: "missing" });

    const userResp = await supabase.from("users").select("*").eq("id", user_id).single();
    if (userResp.error && userResp.error.code !== "PGRST116") return res.status(500).json({ error: userResp.error });

    const isPremium = (userResp.data && userResp.data.premium) || false;
    const max = isPremium ? 7 : 3;

    const botsResp = await supabase.from("bots").select("id").eq("user_id", user_id);
    if (botsResp.error) return res.status(500).json({ error: botsResp.error });
    if (botsResp.data.length >= max) return res.status(400).json({ error: "limit" });

    const id = uuidv4();
    const enc = encrypt(token);

    const insert = await supabase.from("bots").insert({
      id,
      user_id,
      encrypted_token: enc,
      language,
      name: name || "My Bot",
      created_at: new Date().toISOString(),
    });

    if (insert.error) return res.status(500).json({ error: insert.error });

    const starter = language === "py"
      ? `import discord\nfrom discord.ext import commands\n\nbot = commands.Bot(command_prefix='!')\n\n@bot.event\nasync def on_ready():\n    print(f'Bot online: {bot.user}')\n\nbot.run('${token}')\n`
      : `module.exports = async (client) => {\n  console.log('Bot started!')\n}\n`;

    const fileName = language === "py" ? "main.py" : "index.js";
    const upload = await supabase.storage.from("bot_files").upload(`${id}/${fileName}`, Buffer.from(starter), { contentType: "text/plain", upsert: true });
    if (upload.error) return res.status(500).json({ error: upload.error.message || upload.error });

    return res.json({ id });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
});

app.get("/api/bots/:user_id", async (req, res) => {
  try {
    const { user_id } = req.params;
    const r = await supabase.from("bots").select("*").eq("user_id", user_id);
    if (r.error) return res.status(500).json({ error: r.error });
    return res.json(r.data);
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
});

app.get("/api/files/:botId", async (req, res) => {
  try {
    const { botId } = req.params;
    const { data, error } = await supabase.storage.from("bot_files").list(botId, { limit: 100 });
    if (error) return res.status(500).json({ error: error.message || error });
    const files = (data || []).map(f => f.name);
    return res.json({ files });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
});

app.get("/api/file/:botId/:fname", async (req, res) => {
  try {
    const { botId, fname } = req.params;
    const { data, error } = await supabase.storage.from("bot_files").download(`${botId}/${fname}`);
    if (error) return res.json({ code: "" });
    const text = await data.text();
    return res.json({ code: text });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
});

app.post("/api/file/:botId/:fname", async (req, res) => {
  try {
    const { botId, fname } = req.params;
    const { code } = req.body;
    const upload = await supabase.storage.from("bot_files").upload(`${botId}/${fname}`, Buffer.from(code || ""), { contentType: "text/plain", upsert: true });
    if (upload.error) return res.status(500).json({ error: upload.error.message || upload.error });
    await supabase.from("bots").update({ updated_at: new Date().toISOString() }).eq("id", botId);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
});

app.post("/api/start/:botId", async (req, res) => {
  try {
    const { botId } = req.params;
    const { user_id } = req.body;

    if (processes[botId]) return res.json({ ok: true });

    const botResp = await supabase.from("bots").select("*").eq("id", botId).single();
    if (botResp.error || !botResp.data)
      return res.status(404).json({ error: "Bot not found" });

    if (botResp.data.user_id !== user_id)
      return res.status(403).json({ error: "Forbidden" });

    const userResp = await supabase
      .from("users")
      .select("premium")
      .eq("id", user_id)
      .single();
    const isPremium = userResp.data?.premium || false;

    const token = decrypt(botResp.data.encrypted_token);
    const isPython = botResp.data.language === "py";
    const fileName = isPython ? "main.py" : "index.js";

    const { data, error } = await supabase.storage
      .from("bot_files")
      .download(`${botId}/${fileName}`);
    if (error || !data)
      return res.status(500).json({ error: "Bot file not found" });

    const tmpPath = path.join("/tmp", botId);
    fs.mkdirSync(tmpPath, { recursive: true });
    const code = await data.text();
    fs.writeFileSync(path.join(tmpPath, fileName), code);

    const secretsRes = await supabase
      .from("bot_secrets")
      .select("*")
      .eq("bot_id", botId);
    const envVars = { ...process.env };
    if (secretsRes.data) {
      for (const s of secretsRes.data) {
        try {
          envVars[s.key] = decrypt(s.value);
        } catch {
          envVars[s.key] = s.value;
        }
      }
    }

    envVars.TOKEN = token;
    envVars.BOT_ID = botId;
    envVars.BOT_LANGUAGE = botResp.data.language;

    let child;
    if (isPython) {
      child = spawn("python3", [fileName], {
        cwd: tmpPath,
        env: envVars,
        stdio: ["ignore", "pipe", "pipe", "ipc"]
      });
    } else {
      child = fork(path.join(__dirname, "bot_runner.js"), [token, path.join(tmpPath, fileName), botId], {
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        env: envVars
      });
    }

    processes[botId] = { proc: child, owner: user_id, premium: isPremium };
    logs[botId] = logs[botId] || [];

    child.stdout.on("data", d => logs[botId].push(d.toString()));
    child.stderr.on("data", d => logs[botId].push("[ERR] " + d.toString()));
    child.on("message", msg => {
      if (msg.type === "log" || msg.type === "error") logs[botId].push(msg.data);
    });
    child.on("exit", code => {
      delete processes[botId];
      logs[botId].push(`[EXIT] Process ended with code ${code}`);
    });

    if (!isPremium) {
      const MAX_RUN_TIME = 90 * 60 * 1000; 
      setTimeout(() => {
        const p = processes[botId];
        if (p && !p.premium) {
          console.log(`[AUTO] Stopping free bot ${botId} after 30 minutes`);
          try {
            p.proc.kill("SIGTERM");
          } catch {}
          delete processes[botId];
          logs[botId].push("[AUTO] Free bot stopped after 30 minutes limit.");
        }
      }, MAX_RUN_TIME);
    }

    if (!isPremium) {
      console.log(`[INFO] Started free bot ${botId} (will stop automatically after 30 mins)`);
    } else {
      console.log(`[INFO] Started premium bot ${botId} (24/7 mode)`);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("Error starting bot:", err);
    res.status(500).json({ error: err.message });
  }
});
app.post("/api/stop/:botId", async (req, res) => {
  try {
    const { botId } = req.params;
    const { user_id } = req.body;
    const p = processes[botId];
    if (!p) return res.json({ ok: true });
    if (p.owner !== user_id) return res.status(403).json({ error: "forbidden" });
    p.proc.kill("SIGTERM");
    delete processes[botId];
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
});

app.get("/api/logs/:botId", (req, res) => {
  const { botId } = req.params;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (msg) => res.write(`data: ${msg.replace(/\n/g, "\\n")}\n\n`);
  if (logs[botId] && Array.isArray(logs[botId])) {
    logs[botId].forEach((m) => send(m));
  }

  const keepAlive = setInterval(() => {
    res.write(":\n\n");
  }, 20000);

  req.on("close", () => {
    clearInterval(keepAlive);
  });
});

app.post("/api/add-secret", async (req, res) => {
  try {
    const { bot_id, user_id, key, value } = req.body;
    if (!bot_id || !user_id || !key || !value) return res.status(400).json({ error: "missing fields" });

    const botCheck = await supabase.from("bots").select("user_id").eq("id", bot_id).single();
    if (botCheck.error || !botCheck.data) return res.status(404).json({ error: "bot not found" });
    if (botCheck.data.user_id !== user_id) return res.status(403).json({ error: "forbidden" });

    const enc = encrypt(value);

    const existing = await supabase.from("bot_secrets").select("id").eq("bot_id", bot_id).eq("key", key).maybeSingle();

    if (existing.data) {
      const update = await supabase.from("bot_secrets").update({ value: enc }).eq("id", existing.data.id);
      if (update.error) throw update.error;
    } else {
      const insert = await supabase.from("bot_secrets").insert({ bot_id, key, value: enc });
      if (insert.error) throw insert.error;
    }

    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
});

app.get("/api/secrets/:bot_id", async (req, res) => {
  try {
    const { bot_id } = req.params;
    const secrets = await supabase.from("bot_secrets").select("key, created_at").eq("bot_id", bot_id).order("created_at", { ascending: true });
    if (secrets.error) throw secrets.error;
    return res.json({ data: secrets.data });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
});

app.post("/api/delete-secret", async (req, res) => {
  try {
    const { bot_id, key } = req.body;
    if (!bot_id || !key) return res.status(400).json({ error: "missing" });
    const del = await supabase.from("bot_secrets").delete().eq("bot_id", bot_id).eq("key", key);
    if (del.error) throw del.error;
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
});

app.post("/api/create-checkout", async (req, res) => {
  try {
    const { user_id } = req.body;
    const price = process.env.STRIPE_PRICE_ID;
    const base = process.env.BASE_URL || "";
    if (!price) return res.status(500).json({ error: "no_price" });

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price, quantity: 1 }],
      metadata: { user_id },
      success_url: `${base}/dashboard.html?checkout=success`,
      cancel_url: `${base}/dashboard.html?checkout=cancel`
    });

    return res.json({ url: session.url });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
});

app.post("/api/manage-billing", async (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ error: "Missing user_id" });

    const user = await supabase.from("users").select("stripe_customer_id").eq("id", user_id).single();
    if (user.error || !user.data?.stripe_customer_id) return res.status(400).json({ error: "No active subscription found" });

    const returnUrl = process.env.BASE_URL || `https://dcbothoster.onrender.com`;

    const session = await stripe.billingPortal.sessions.create({
      customer: user.data.stripe_customer_id,
      return_url: `${returnUrl}/dashboard.html`
    });

    return res.json({ url: session.url });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
});

app.post("/api/stripe-webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET || "");
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const session = event.data.object;
  const user_id = session.metadata?.user_id;

  try {
    if (!user_id) {
      return res.status(400).json({ error: "Missing user_id metadata" });
    }

    switch (event.type) {
      case "checkout.session.completed":
      case "invoice.payment_succeeded":
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const sub = session.subscription ? await stripe.subscriptions.retrieve(session.subscription) : session;
        if (sub.cancel_at_period_end) break;
        const expires = new Date(sub.current_period_end * 1000);
        await supabase.from("users").upsert({
          id: user_id,
          premium: true,
          premium_expires_at: expires.toISOString(),
          stripe_customer_id: sub.customer
        });
        break;
      }

      case "customer.subscription.deleted":
      case "invoice.payment_failed":
      case "subscription_schedule.canceled":
      case "subscription_schedule.completed": {
        await supabase.from("users").update({ premium: false, premium_expires_at: null }).eq("id", user_id);
        break;
      }

      case "subscription_schedule.expiring":
      case "customer.subscription.trial_will_end": {
        break;
      }

      default: {
        break;
      }
    }

    return res.json({ received: true });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
});
app.post("/api/verify-human", async (req, res) => {
  const { token } = req.body;

  let ip =
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket.remoteAddress;

  if (ip.startsWith("::ffff:")) ip = ip.replace("::ffff:", "");

  // ✅ Step 1 — Verify reCAPTCHA token
  const secret = process.env.RECAPTCHA_SECRET;
  const verifyUrl = `https://www.google.com/recaptcha/api/siteverify?secret=${secret}&response=${token}`;

  try {
    const captchaResp = await fetch(verifyUrl, { method: "POST" });
    const captchaData = await captchaResp.json();

    if (!captchaData.success) {
      return res.status(400).json({ error: "Captcha verification failed." });
    }
  } catch (err) {
    console.error("Captcha verification error:", err);
    return res.status(400).json({ error: "Captcha verification failed." });
  }

  // ✅ Step 2 — Skip VPN check for local or private IPs
  const isPrivate =
    ip === "127.0.0.1" ||
    ip === "::1" ||
    ip.startsWith("10.") ||
    ip.startsWith("192.168.") ||
    ip.startsWith("172.");

  if (isPrivate) {
    return res.json({ ok: true });
  }

  // ✅ Step 3 — Check VPN/proxy using ipapi.is
  try {
    const vpnResp = await fetch(`https://api.ipapi.is/?ip=${ip}`);
    const vpnData = await vpnResp.json();

    const isBad =
      vpnData.is_vpn === true ||
      vpnData.is_proxy === true ||
      vpnData.is_datacenter === true;

    if (isBad) {
      return res.json({ vpnBlocked: true });
    }

  } catch (err) {
    console.error("VPN check failed:", err);
    // Do NOT block user if API fails
  }

  return res.json({ ok: true });
});

app.post("/api/cancel-subscription", async (req, res) => {
  try {
    const { user_id } = req.body;
    const user = await supabase.from("users").select("stripe_customer_id").eq("id", user_id).single();
    if (user.error || !user.data || !user.data.stripe_customer_id) return res.status(404).json({ error: "no_customer" });

    const subs = await stripe.subscriptions.list({ customer: user.data.stripe_customer_id, limit: 1 });
    if (subs.data.length === 0) return res.status(404).json({ error: "no_subscription" });

    const subId = subs.data[0].id;
    await stripe.subscriptions.update(subId, { cancel_at_period_end: true });
    await supabase.from("users").update({ premium: false }).eq("id", user_id);
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
});
app.post("/api/store-ip", async (req, res) => {
  const { user_id } = req.body;
  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress;

  if (!user_id) return res.status(400).json({ error: "missing user_id" });

  const { error } = await supabase
    .from("users")
    .update({ last_ip: ip })
    .eq("id", user_id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});
app.get("/api/user/:user_id", async (req, res) => {
  try {
    const { user_id } = req.params;
    const r = await supabase.from("users").select("*").eq("id", user_id).single();
    if (r.error || !r.data) return res.status(404).json({ error: "not found" });

    const user = r.data;
    let days_left = 0;
    if (user.premium_expires_at) {
      const now = new Date();
      const exp = new Date(user.premium_expires_at);
      days_left = Math.ceil((exp - now) / (1000 * 60 * 60 * 24));
    }

    return res.json({
      id: user.id,
      username: user.username,
      avatar_url: user.avatar_url,
      premium: !!user.premium,
      days_left: days_left > 0 ? days_left : 0
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
});
app.get("/.well-known/discord", (req, res) => {
  res.type("text/plain").send("dh=70be70aa6de25e5ef596ebe65fc5f109e384f3f5");
});
app.get("/health", async (req, res) => {
  try {
    if (!DISCORD_WEBHOOK) {
      console.warn("⚠️ DISCORD_WEBHOOK not set in environment!");
      return res.status(200).send("OK - No webhook configured");
    }

    const response = await fetch(DISCORD_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        embeds: [
          {
            title: "✅ Ping Successful",
            description: "GitHub Actions just pinged the web app successfully.",
            color: 0x00ff00,
            timestamp: new Date(),
          },
        ],
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error("Discord API error:", response.status, text);
      return res.status(500).send("Discord webhook error");
    }

    res.status(200).send("OK");
  } catch (err) {
    console.error("Error sending to Discord:", err);
    res.status(500).send("Error");
  }
});
async function restartPremiumBots() {
  try {
    const { data: users, error } = await supabase.from("users").select("id").eq("premium", true);
    if (error || !Array.isArray(users)) return;
    for (const user of users) {
      const { data: bots } = await supabase.from("bots").select("id, language, encrypted_token").eq("user_id", user.id);
      if (!bots || !Array.isArray(bots)) continue;
      for (const b of bots) {
        try {
          await fetch(`http://localhost:${PORT}/api/start/${b.id}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ user_id: user.id })
          });
        } catch {}
      }
    }
  } catch {}
}

app.listen(PORT, async () => {
  console.log("✅ Server running on port", PORT);
  setTimeout(restartPremiumBots, 5000);
});
