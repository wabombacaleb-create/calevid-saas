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

/* =========================
   CONFIG
========================= */
const WP_SITE_URL = (process.env.WP_SITE_URL || "")
  .trim()
  .replace(/\/+$/, "");

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;
const WEBHOOK_SECRET = process.env.CALEVID_WEBHOOK_SECRET;

fal.config({
  credentials: process.env.FAL_KEY,
});

/* =========================
   GLOBAL MIDDLEWARE
========================= */
app.use(cors());

const httpsAgent = new https.Agent({
  keepAlive: false,
  rejectUnauthorized: true,
  family: 4,
});

const log = (...args) =>
  console.log(`[${new Date().toISOString()}]`, ...args);

/* =========================
   HEALTH CHECK
========================= */
app.get("/", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

/* =========================
   PAYSTACK WEBHOOK — PRODUCTION READY
========================= */
app.post(
  "/paystack-webhook",
  express.raw({ type: "application/json" }),
  (req, res) => {
    log("🔥 PAYSTACK WEBHOOK HIT");

    const body = req.body;
    const signature = req.headers["x-paystack-signature"];
    const secretKey = PAYSTACK_SECRET || "";

    if (!signature || !secretKey) {
      log("❌ Missing Paystack signature or secret");
      return res.sendStatus(401);
    }

    const hash = crypto
      .createHmac("sha512", secretKey)
      .update(body)
      .digest("hex");

    if (hash !== signature) {
      log("❌ Invalid Paystack signature");
      return res.sendStatus(401);
    }

    let event;
    try {
      event = JSON.parse(body.toString("utf8"));
    } catch (e) {
      log("❌ Failed to parse webhook body", e.message);
      return res.sendStatus(400);
    }

    log("🔔 Paystack event:", event?.event, event?.data?.status);

    res.sendStatus(200);

    if (event.event !== "charge.success" || event.data?.status !== "success") return;

    const { reference, customer, amount } = event.data || {};
    const email = (customer?.email || "").trim().toLowerCase();
    const credits = Math.floor((amount || 0) / 100 / 150);

    if (!email || !reference || credits <= 0) {
      log("⚠️ Invalid data for credit application", { email, reference, credits });
      return;
    }

    if (!WP_SITE_URL || !WEBHOOK_SECRET) {
      log("❌ Missing WP_SITE_URL or CALEVID_WEBHOOK_SECRET");
      return;
    }

    const url = `${WP_SITE_URL}/wp-json/calevid/v1/apply-credits`;
    log("➡️ Calling WordPress:", url, { email, reference, credits });

    setImmediate(async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      try {
        const bodyParams = new URLSearchParams({
          secret: String(WEBHOOK_SECRET).trim(),
          email,
          credits: String(credits),
          reference: String(reference).trim(),
        });

        const wpRes = await fetch(url, {
          method: "POST",
          agent: httpsAgent,
          signal: controller.signal,
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "Calevid-Webhook/1.0",
            Accept: "application/json",
          },
          body: bodyParams,
        });

        const result = await wpRes.json();

        if (wpRes.ok) {
          log("✅ WordPress response:", wpRes.status, result);
          if (result.creditsAdded === 0) {
            log("⚠️ Duplicate or already-applied reference:", reference);
          }
        } else {
          log("❌ WordPress returned error:", wpRes.status, result);
        }
      } catch (err) {
        log("❌ WordPress request failed:", err.name, err.message);
      } finally {
        clearTimeout(timeout);
      }
    });
  }
);

/* =========================
   JSON PARSER
========================= */
app.use(express.json());

/* =========================
   VIDEO GENERATION (fal.ai) — FULLY FIXED
========================= */
app.post("/generate-video", async (req, res) => {

  try {

    const { prompt } = req.body;

    if (!prompt)
      return res.status(400).json({ error: "Prompt required" });

    log("🎬 Submitting Ovi generation:", prompt);

    const submit = await fal.queue.submit("fal-ai/ovi", {
      input: { prompt }
    });

    const requestId = submit?.request_id;

    if (!requestId)
      throw new Error("No request ID returned");

    log("🆔 Request ID:", requestId);

    let result;

    while (true) {

      const status = await fal.queue.status("fal-ai/ovi", {
        requestId
      });

      log("📊 Status:", status.status);

      if (status.status === "COMPLETED") {

        result = await fal.queue.result("fal-ai/ovi", {
          requestId
        });

        break;

      }

      if (status.status === "FAILED")
        throw new Error("Generation failed");

      await new Promise(resolve => setTimeout(resolve, 4000));

    }

    /* ===== FIXED OUTPUT EXTRACTION ===== */

    let videoUrl = null;

    if (result?.data?.video?.url)
      videoUrl = result.data.video.url;

    else if (result?.data?.outputs?.[0]?.video?.url)
      videoUrl = result.data.outputs[0].video.url;

    else if (result?.video?.url)
      videoUrl = result.video.url;

    else if (result?.outputs?.[0]?.video?.url)
      videoUrl = result.outputs[0].video.url;

    if (!videoUrl)
      throw new Error("No video URL returned");

    log("✅ Video ready:", videoUrl);

    /* =========================
       SEND VIDEO TO WORDPRESS
    ========================= */
    if (WP_SITE_URL && WEBHOOK_SECRET) {

      const wpUrl = `${WP_SITE_URL}/wp-json/calevid/v1/save-video`;

      const bodyParams = new URLSearchParams({
        secret: String(WEBHOOK_SECRET).trim(),
        prompt: String(prompt).trim(),
        videoUrl: String(videoUrl).trim()
      });

      log("➡️ Sending video to WordPress:", wpUrl);

      fetch(wpUrl, {
        method: "POST",
        agent: httpsAgent,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "Calevid-Video/1.0",
          Accept: "application/json"
        },
        body: bodyParams
      })
      .then(r => r.json())
      .then(data => log("✅ WordPress video saved:", data))
      .catch(err => log("❌ WordPress save failed:", err.message));

    } else {
      log("⚠️ WP_SITE_URL or WEBHOOK_SECRET missing");
    }

    res.json({
      status: "success",
      videoUrl: videoUrl
    });

  }
  catch (err) {

    log("❌ Video generation failed:", err.message);

    res.status(500).json({
      error: "Generation failed"
    });

  }

});
/* =========================
   START SERVER
========================= */
app.listen(PORT, () => {

  log(`🚀 Calevid backend running on port ${PORT}`);

});
