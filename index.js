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
const WP_SITE_URL = (process.env.WP_SITE_URL || "").trim().replace(/\/+$/, "");

const httpsAgent = new https.Agent({
  keepAlive: false,
  rejectUnauthorized: true,
  family: 4,
});

fal.config({ credentials: process.env.FAL_KEY });
const log = (...args) => console.log(`[${new Date().toISOString()}]`, ...args);

// ======================
// HEALTH CHECK
// ======================
app.get("/", (req, res) => res.send({ status: "ok", time: new Date().toISOString() }));

// ======================
// PAYSTACK WEBHOOK (raw body for signature)
// ======================
app.post("/paystack-webhook", express.raw({ type: "application/json" }), (req, res) => {
  log("🔥 PAYSTACK WEBHOOK HIT");

  const rawBody = req.body; // Buffer
  const signature = req.headers["x-paystack-signature"];
  const secretKey = process.env.PAYSTACK_SECRET_KEY || "";

  // Validate signature
  const hash = crypto.createHmac("sha512", secretKey).update(rawBody).digest("hex");
  if (hash !== signature) {
    log("❌ Invalid Paystack signature");
    return res.sendStatus(401);
  }

  // Parse JSON after signature verified
  let event;
  try {
    event = JSON.parse(rawBody.toString());
  } catch (err) {
    log("❌ Invalid JSON payload");
    return res.sendStatus(400);
  }

  res.sendStatus(200); // respond immediately to Paystack

  if (event.event !== "charge.success") return;

  const { reference, customer, amount } = event.data;
  const email = (customer?.email || "").trim();
  const credits = Math.floor(amount / 100 / 150); // 150 KSh per credit

  if (!email || credits <= 0) return;

  log("Processing credits", { email, credits, reference });

  setImmediate(async () => {
    const url = `${WP_SITE_URL}/wp-json/calevid/v1/apply-credits`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
      const wpRes = await fetch(url, {
        method: "POST",
        agent: httpsAgent,
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Calevid-Webhook/1.0",
          "Accept": "application/json",
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
app.use(express.json()); // parse JSON for other endpoints

app.post("/generate-video", async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: "Prompt required" });

    const result = await fal.subscribe("fal-ai/ovi", {
      input: { prompt },
      logs: true,
    });

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
