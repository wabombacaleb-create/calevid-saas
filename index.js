import express from "express";
import cors from "cors";
import crypto from "crypto";
import fetch from "node-fetch";
import https from "https";
import dns from "dns";
import { fal } from "@fal-ai/client";

dns.setDefaultResultOrder("ipv4first");

const app = express();
const PORT = process.env.PORT || 10000;

// ======================
// CONFIG
// ======================
const WP_SITE_URL = (process.env.WP_SITE_URL || "").trim().replace(/\/+$/, "");
const httpsAgent = new https.Agent({ keepAlive: false, rejectUnauthorized: true, family: 4 });
fal.config({ credentials: process.env.FAL_KEY });

// ======================
// MIDDLEWARE
// ======================
app.use(cors());

// Only parse raw body for Paystack webhook to validate signature
app.use("/paystack-webhook", express.raw({ type: "application/json" }));

// Normal JSON parsing for other routes
app.use(express.json());

const log = (...args) => console.log(`[${new Date().toISOString()}]`, ...args);

// ======================
// HEALTH
// ======================
app.get("/", (req, res) => res.json({ status: "ok", time: new Date().toISOString() }));

// ======================
// PAYSTACK WEBHOOK
// ======================
app.post("/paystack-webhook", (req, res) => {
  log("🔥 PAYSTACK WEBHOOK HIT");

  const rawBody = req.body; // This is a Buffer because of express.raw()
  const signature = req.headers["x-paystack-signature"];

  // Verify HMAC signature
  const hash = crypto
    .createHmac("sha512", process.env.PAYSTACK_SECRET_KEY || "")
    .update(rawBody)
    .digest("hex");

  if (hash !== signature) {
    log("❌ Invalid Paystack signature");
    return res.sendStatus(401);
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString());
  } catch (err) {
    log("❌ Failed to parse Paystack payload", err.message);
    return res.sendStatus(400);
  }

  res.sendStatus(200); // respond immediately to Paystack

  if (event.event !== "charge.success") return;

  const { reference, customer, amount } = event.data;
  const email = (customer?.email || "").trim();
  const credits = Math.floor(amount / 100 / 150); // 150 KSh per credit

  if (!email || credits <= 0) return;

  log("Processing credits", { email, credits, reference });

  // Apply credits to WordPress asynchronously
  setImmediate(async () => {
    const url = `${WP_SITE_URL}/wp-json/calevid/v1/apply-credits`;
    log("Calling WordPress REST endpoint:", url);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
      const wpRes = await fetch(url, {
        method: "POST",
        agent: httpsAgent,
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "User-Agent": "Calevid-Webhook/1.0",
        },
        body: JSON.stringify({
          secret: process.env.CALEVID_WEBHOOK_SECRET,
          email,
          credits,
          reference,
        }),
      });

      const text = await wpRes.text();
      log("✅ WordPress responded", wpRes.status, text);
    } catch (err) {
      log("❌ WordPress request failed", err.name, err.message);
    } finally {
      clearTimeout(timeout);
    }
  });
});

// ======================
// VIDEO GENERATION
// ======================
app.post("/generate-video", async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: "Prompt required" });

    const result = await fal.subscribe("fal-ai/ovi", { input: { prompt }, logs: true });

    res.json({
      status: "success",
      videoUrl: result?.data?.video?.url,
    });
  } catch (err) {
    log("❌ Video generation failed", err.message);
    res.status(500).json({ error: "Generation failed" });
  }
});

// ======================
// START SERVER
// ======================
app.listen(PORT, () => log(`🚀 Calevid backend running on port ${PORT}`));
