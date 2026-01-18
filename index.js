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

// ✅ FIX 1: trim() added (CRITICAL)
const WP_SITE_URL = (process.env.WP_SITE_URL || "")
  .trim()
  .replace(/\/+$/, "");

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

// ======================
// HEALTH
// ======================
app.get("/", (req, res) => res.send("Calevid backend is running"));

app.get("/status/test", (req, res) => {
  log("Health check hit");
  res.json({ status: "ok" });
});

// ======================
// PAYSTACK WEBHOOK
// ======================
app.post("/paystack-webhook", (req, res) => {
  log("🔥 PAYSTACK WEBHOOK HIT");

  const body = req.body;
  const signature = req.headers["x-paystack-signature"];

  const hash = crypto
    .createHmac("sha512", process.env.PAYSTACK_SECRET_KEY || "")
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

  // Respond immediately to Paystack
  res.sendStatus(200);

  if (event.event !== "charge.success") return;

  const { reference, customer, amount } = event.data;
  const email = (customer?.email || "").trim();
  const credits = Math.floor(amount / 100 / 150);

  if (!email || credits <= 0) return;

  log("Processing credits", { email, credits, reference });

  // Process asynchronously
  setImmediate(async () => {
    // ✅ FIX 2: REST endpoint must be GET
    const params = new URLSearchParams({
      secret: (process.env.CALEVID_WEBHOOK_SECRET || "").trim(),
      email,
      credits: String(credits),
      reference,
    });

    const url = `${WP_SITE_URL}/wp-json/calevid/v1/apply-credits?${params.toString()}`;
    log("Calling WordPress REST endpoint:", url);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);

    try {
      const wpRes = await fetch(url, {
        method: "GET",
        agent: httpsAgent,
        signal: controller.signal,
        headers: {
          "User-Agent": "Calevid-Webhook/1.0 (+https://calevid.com)",
          "Accept": "application/json",
        },
      });

      const text = await wpRes.text();
      log("✅ WordPress responded", {
        status: wpRes.status,
        body: text,
      });
    } catch (err) {
      log("❌ WordPress request failed", {
        name: err.name,
        message: err.message,
        stack: err.stack,
      });
    } finally {
      clearTimeout(timeout);
    }
  });
});

// ======================
// VIDEO GENERATION (UNCHANGED)
// ======================
app.post("/generate-video", async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) {
      return res.status(400).json({
        status: "error",
        message: "Prompt required",
      });
    }

    const result = await fal.subscribe("fal-ai/ovi", {
      input: { prompt },
      logs: true,
    });

    const videoUrl = result?.data?.video?.url;
    if (!videoUrl) {
      return res.status(500).json({
        status: "error",
        message: "Video failed",
      });
    }

    res.json({
      status: "success",
      videoUrl,
      requestId: result.requestId,
    });
  } catch (err) {
    log("❌ Video generation failed", err);
    res.status(500).json({
      status: "error",
      message: "Generation failed",
    });
  }
});

app.listen(PORT, () =>
  log(`🚀 Calevid backend running on port ${PORT}`)
);
