// index.js
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import pino from "pino";
import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} from "@whiskeysockets/baileys";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const OWNER_NUMBER = process.env.OWNER_NUMBER || "254112399557";
const SESSIONS_ROOT = "./session_data"; // root folder for sessions

if (!fs.existsSync(SESSIONS_ROOT)) fs.mkdirSync(SESSIONS_ROOT);

// Keep sockets per sessionId
const SESSIONS = new Map();

/**
 * Ensure session folder path exists for sessionId
 */
function sessionPath(sessionId = "default") {
  const p = path.join(SESSIONS_ROOT, sessionId);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  return p;
}

/**
 * Start a Baileys socket for a session (if not already started)
 * Returns the sock instance
 */
async function startSocket(sessionId = "default") {
  if (SESSIONS.has(sessionId) && SESSIONS.get(sessionId).sock) {
    return SESSIONS.get(sessionId).sock;
  }

  const folder = sessionPath(sessionId);
  const { state, saveCreds } = await useMultiFileAuthState(folder);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    auth: state
  });

  // store in map
  SESSIONS.set(sessionId, { sock, status: "starting" });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "open") {
      SESSIONS.set(sessionId, { sock, status: "connected" });
      console.log(`✅ [${sessionId}] connected`);
    }

    if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode;
      console.log(`[${sessionId}] connection close reason:`, reason);
      if (reason !== DisconnectReason.loggedOut) {
        // try to reconnect
        setTimeout(() => startSocket(sessionId).catch(console.error), 2000);
      } else {
        console.log(`[${sessionId}] logged out — delete session files to re-pair`);
        SESSIONS.set(sessionId, { sock: null, status: "logged_out" });
      }
    }
  });

  // Basic message handler (safe default)
  sock.ev.on("messages.upsert", async (m) => {
    try {
      const msg = m.messages?.[0];
      if (!msg || !msg.message) return;
      const from = msg.key.remoteJid;
      const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";

      // simple commands
      if (text?.toLowerCase() === "ping") {
        await sock.sendMessage(from, { text: "Pong 🏓" });
      }
      if (text?.toLowerCase() === "owner") {
        await sock.sendMessage(from, { text: `My owner is wa.me/${OWNER_NUMBER}` });
      }
    } catch (err) {
      console.error("message handler error:", err);
    }
  });

  return sock;
}

/**
 * Helper: generate pairing code (QR string)
 * If creds already exists, throw or return null
 */
async function getPairingCode(sessionId = "default", timeoutMs = 60000) {
  const folder = sessionPath(sessionId);
  const credsFile = path.join(folder, "creds.json");

  if (fs.existsSync(credsFile)) {
    return { alreadyPaired: true };
  }

  // start socket to produce QR
  const sock = await startSocket(sessionId);

  // Try requestPairingCode if available (some versions support it)
  if (typeof sock.requestPairingCode === "function") {
    try {
      const code = await sock.requestPairingCode(OWNER_NUMBER);
      return { code };
    } catch (err) {
      // fallback to listening for qr event
      console.warn("requestPairingCode failed — falling back to qr event:", err?.message);
    }
  }

  // fallback: wait for connection.update { qr }
  return await new Promise((resolve, reject) => {
    const onUpdate = (update) => {
      const { qr } = update;
      if (qr) {
        // remove listener
        sock.ev.off("connection.update", onUpdate);
        resolve({ code: qr });
      }
    };

    const timer = setTimeout(() => {
      sock.ev.off("connection.update", onUpdate);
      reject(new Error("Timed out waiting for pairing QR"));
    }, timeoutMs);

    sock.ev.on("connection.update", onUpdate);
  });
}

/* -----------------------
   API ROUTES
   ----------------------- */

/**
 * POST /api/generate
 * body: { sessionId?: string }
 * returns { pairing_code: string } or { message: "already_paired" }
 */
app.post("/api/generate", async (req, res) => {
  const sessionId = req.body?.sessionId || "default";
  try {
    const result = await getPairingCode(sessionId);
    if (result.alreadyPaired) {
      return res.json({ message: "already_paired" });
    }
    return res.json({ pairing_code: result.code });
  } catch (err) {
    console.error("generate error:", err);
    return res.status(500).json({ error: "Failed to generate pairing code", detail: err?.message });
  }
});

/**
 * POST /api/deploy
 * body: { sessionId?: string }
 * returns { success: true }
 *
 * For Baileys pairing, after scanning QR from WhatsApp, Baileys will save creds automatically.
 * This endpoint ensures the socket is started/kept alive after pairing.
 */
app.post("/api/deploy", async (req, res) => {
  const sessionId = req.body?.sessionId || "default";
  try {
    await startSocket(sessionId);
    return res.json({ success: true, message: "Bot start/ensure invoked" });
  } catch (err) {
    console.error("deploy error:", err);
    return res.status(500).json({ error: "Failed to deploy bot", detail: err?.message });
  }
});

/**
 * GET /api/status?sessionId=...
 * returns { success: true, status: "connected"|"stopped"|"starting"|"logged_out" }
 */
app.get("/api/status", (req, res) => {
  const sessionId = req.query.sessionId || "default";
  const record = SESSIONS.get(sessionId);
  const status = record?.status || "stopped";
  return res.json({ success: true, status });
});

/* simple homepage */
app.get("/", (req, res) => {
  res.send("✅ RAHL WhatsApp Bot Backend Running");
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
