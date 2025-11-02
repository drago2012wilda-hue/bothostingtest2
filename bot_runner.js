const { createClient } = require("@supabase/supabase-js");
const { spawn } = require("child_process");
const vm = require("vm");
const fs = require("fs");
const path = require("path");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function send(type, data) {
  if (process.send) process.send({ type, data });
}

(async () => {
  try {
    const language = process.env.BOT_LANGUAGE || "js";
    const token = process.env.TOKEN;
    const botId = process.env.BOT_ID;

    console.log(`[INFO] Launching bot ${botId} (${language})`);

    if (language === "py") {
      const { data, error } = await supabase.storage
        .from("bot_files")
        .download(`${botId}/main.py`);
      if (error || !data) throw new Error("Python code not found in Supabase");

      const code = await data.text();
      const scriptPath = `/tmp/${botId}.py`;
      fs.writeFileSync(scriptPath, code);

      const proc = spawn("python3", [scriptPath], {
        env: { ...process.env, BOT_TOKEN: token },
      });

      proc.stdout.on("data", (d) => {
        const msg = d.toString();
        process.stdout.write(msg);
        send("log", msg);
      });

      proc.stderr.on("data", (d) => {
        const msg = d.toString();
        process.stderr.write("[ERR] " + msg);
        send("error", msg);
      });

      proc.on("close", (code) => {
        const msg = `[EXIT] Python bot ${botId} exited with code ${code}`;
        console.log(msg);
        send("log", msg);
        process.exit(code);
      });

      return;
    }

    const { data, error } = await supabase.storage
      .from("bot_files")
      .download(`${botId}/index.js`);
    if (error || !data) throw new Error("JavaScript code not found in Supabase");

    const code = await data.text();

    try {
      require.resolve("discord.js");
    } catch {
      console.log("[INFO] Installing discord.js...");
      await new Promise((resolve, reject) => {
        const install = spawn("npm", ["install", "discord.js"], {
          cwd: __dirname,
          stdio: ["ignore", "pipe", "pipe"],
        });
        install.stdout.on("data", (d) => process.stdout.write(d.toString()));
        install.stderr.on("data", (d) =>
          process.stderr.write("[ERR] " + d.toString())
        );
        install.on("close", (code) => (code === 0 ? resolve() : reject()));
      });
    }

    const { Client, GatewayIntentBits } = require("discord.js");
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    client.once("clientReady", () => {
      const msg = `Bot ${client.user.tag} is online!`;
      console.log(msg);
      send("log", msg);
    });

const sandbox = {
  console,
  require,
  client,
  token,
  process,
  module: {},
  setTimeout,
  setInterval,
  clearTimeout,
  clearInterval,
};

sandbox.globalThis = globalThis;
sandbox.global = sandbox; 
sandbox.fetch = globalThis.fetch;

sandbox.Buffer = Buffer;
sandbox.__dirname = "/tmp";
sandbox.__filename = "index.js";

vm.createContext(sandbox);

    client.once("clientReady", async () => {
      try {
        await vm.runInContext(code, sandbox, { timeout: 10000 });
      } catch (e) {
        console.error("Error in user code:", e);
        send("error", "Error in user code: " + e.toString());
      }
    });

    await client.login(token).catch((e) => {
      console.error("Login failed:", e);
      send("error", `Login failed: ${e.message}`);
      process.exit(1);
    });
  } catch (err) {
    console.error("[ERR]", err);
    send("error", err.message);
    process.exit(1);
  }
})();
