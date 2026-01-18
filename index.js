import express from "express";
import cors from "cors";
import crypto from "crypto";
import fetch from "node-fetch";
import https from "https";
import dns from "dns";
import { fal } from "@fal-ai/client";

// 🔧 FORCE IPV4 for Hostinger compatibility
dns.setDefaultResultOrder("ipv4first");

const app = express();
const PORT = process.env.PORT || 10000;
const WP_SITE_URL = (process.env.WP_SITE_URL || '').replace(/\/+$/, "").trim();

const httpsAgent = new https.Agent({
  keepAlive: true,
  rejectUnauthorized: false, // temporary for testing TLS handshake
  family: 4, // force IPv4
});

app.use(cors());
app.use("/paystack-webhook", express.raw({ type: "application/json" }));
app.use(express.json());

fal.config({ credentials: process.env.FAL_KEY });

const log = (...args) => console.log(`[${new Date().toISOString()}]`, ...args);

// =================================================
// HEALTH
// =================================================
app.get("/", (req, res) => res.send("Calevid backend is running"));
app.get("/status/test", (req, res) => {
  log("Health check hit");
  res.json({ status: "ok" });
});

// =================================================
// PAYSTACK WEBHOOK
// =================================================
app.post("/paystack-webhook", (req, res) => {
  log("🔥 PAYSTACK WEBHOOK HIT");

  const body = req.body;
  const signature = req.headers["x-paystack-signature"];

  const hash = crypto
    .createHmac("sha512", process.env.PAYSTACK_SECRET_KEY)
    .update(body)
    .digest("hex");

  if (hash !== signature) {
    log("❌ Invalid Paystack signature");
    return res.sendStatus(401);
  }

  let event;
  try {
    event = JSON.parse(body.toString());
  } catch (err) {
    log("❌ Invalid JSON body", err);
    return res.sendStatus(400);
  }

  res.sendStatus(200);

  if (event.event !== "charge.success") return;

  const { reference, customer, amount } = event.data;
  const email = customer?.email?.trim();
  const credits = Math.floor(amount / 100 / 150);

  if (!email || credits <= 0) return;

  log("Processing credits", { email, credits, reference });

  setImmediate(async () => {
    const url = `${WP_SITE_URL}/wp-admin/admin-ajax.php?action=calevid_apply_credits`.replace(/\s+/g, '');
    log("Calling WordPress admin-ajax.php URL:", url);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000); // 60s timeout

    try {
      const wpRes = await fetch(url, {
        method: "POST",
        agent: httpsAgent,
        signal: controller.signal,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "Calevid-Webhook/1.0 (+https://calevid.com)",
          "Accept": "application/json",
        },
        body: new URLSearchParams({
          secret: (process.env.CALEVID_WEBHOOK_SECRET || '').trim(),
          email,
          credits: String(credits),
          reference,
        }),
      });

      const text = await wpRes.text();
      log("✅ WordPress responded", {
        status: wpRes.status,
        statusText: wpRes.statusText,
        headers: Object.fromEntries(wpRes.headers.entries()),
        body: text,
      });
    } catch (err) {
      log("❌ WordPress request failed", {
        name: err.name,
        message: err.message,
        cause: err.cause,
        stack: err.stack,
      });
    } finally {
      clearTimeout(timeout);
    }
  });
});

// =================================================
// VIDEO GENERATION (UNCHANGED)
// =================================================
app.post("/generate-video", async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt)
      return res.status(400).json({ status: "error", message: "Prompt required" });

    const result = await fal.subscribe("fal-ai/ovi", {
      input: { prompt },
      logs: true,
    });

    const videoUrl = result?.data?.video?.url;
    if (!videoUrl)
      return res.status(500).json({ status: "error", message: "Video failed" });

    res.json({
      status: "success",
      videoUrl,
      requestId: result.requestId,
    });
  } catch (err) {
    log("❌ Video generation failed", err);
    res.status(500).json({ status: "error", message: "Generation failed" });
  }
});

// =================================================
// START SERVER
// =================================================
app.listen(PORT, () => log(`🚀 Calevid backend running on port ${PORT}`));

// =================================================
// TEMPORARY TEST ROUTE (debug fetch to WordPress from Render)
app.get("/test-wp", async (req, res) => {
  try {
    const url = `${WP_SITE_URL}/wp-admin/admin-ajax.php?action=calevid_apply_credits`.replace(/\s+/g, '');
    log("Testing WordPress fetch from Render:", url);
    const wpRes = await fetch(url, { method: "GET", agent: httpsAgent, timeout: 10000 });
    const text = await wpRes.text();
    log("Test WP Response:", wpRes.status, text);
    res.json({ status: wpRes.status, body: text });
  } catch (err) {
    log("Test WP fetch failed", err);
    res.status(500).json({ error: err.message });
  }
});
