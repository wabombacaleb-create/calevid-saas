import express from "express";
import cors from "cors";
import crypto from "crypto";
import fetch from "node-fetch";
import https from "https";
import dns from "dns";
import { fal } from "@fal-ai/client";

/**
 * 🔧 FORCE IPV4 (CRITICAL FIX)
 * Render sometimes prefers IPv6, Hostinger may not accept it
 */
dns.setDefaultResultOrder("ipv4first");

const app = express();
const PORT = process.env.PORT || 10000;
const WP_SITE_URL = process.env.WP_SITE_URL.replace(/\/+$/, "");

// HTTPS agent with keep-alive and IPv4
const httpsAgent = new https.Agent({
  keepAlive: true,
  rejectUnauthorized: true,
  family: 4,
});

app.use(cors());
app.use("/paystack-webhook", express.raw({ type: "application/json" }));
app.use(express.json());

fal.config({ credentials: process.env.FAL_KEY });

const log = (...args) =>
  console.log(`[${new Date().toISOString()}]`, ...args);

// =================================================
// HEALTH
// =================================================
app.get("/", (req, res) => res.send("Calevid backend is running"));
app.get("/status/test", (req, res) => {
  log("Health check hit");
  res.json({ status: "ok" });
});

// =================================================
// PAYSTACK WEBHOOK (REST endpoint)
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

  // ✅ Immediate 200 to Paystack
  res.sendStatus(200);

  if (event.event !== "charge.success") return;

  log("Webhook event received charge.success");

  const { reference, customer, amount } = event.data;
  const email = customer?.email;
  const credits = Math.floor(amount / 100 / 150);

  if (!email || credits <= 0) return;

  log("Processing credits", { email, credits, reference });

  // Use REST endpoint for credit application
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
          "User-Agent": "Calevid-Webhook/1.0 (+https://calevid.com)",
          Accept: "application/json",
        },
        body: JSON.stringify({
          secret: process.env.CALEVID_WEBHOOK_SECRET,
          email,
          credits,
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
      return res
        .status(400)
        .json({ status: "error", message: "Prompt required" });

    const result = await fal.subscribe("fal-ai/ovi", {
      input: { prompt },
      logs: true,
    });

    const videoUrl = result?.data?.video?.url;
    if (!videoUrl)
      return res
        .status(500)
        .json({ status: "error", message: "Video failed" });

    res.json({
      status: "success",
      videoUrl,
      requestId: result.requestId,
    });
  } catch (err) {
    log("❌ Video generation failed", err);
    res
      .status(500)
      .json({ status: "error", message: "Generation failed" });
  }
});

app.listen(PORT, () =>
  log(`🚀 Calevid backend running on port ${PORT}`)
);
