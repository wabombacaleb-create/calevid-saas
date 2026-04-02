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
const API_KEY = process.env.API_KEY || "";
const SAFE_MODE = process.env.SAFE_MODE === "true";

fal.config({
  credentials: process.env.FAL_KEY,
});
const SAFE_MODE = process.env.SAFE_MODE === "true";

console.log("SAFE_MODE:", SAFE_MODE);

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
   JOB STORE (NEW)
========================= */
const jobs = new Map();

/* =========================
   HEALTH CHECK
========================= */
app.get("/", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

/* =========================
   PAYSTACK WEBHOOK — UNTOUCHED
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

    if (!email || !reference || credits <= 0) return;

    if (!WP_SITE_URL || !WEBHOOK_SECRET) return;

    const url = `${WP_SITE_URL}/wp-json/calevid/v1/apply-credits`;

    setImmediate(async () => {
      try {
        const bodyParams = new URLSearchParams({
          secret: WEBHOOK_SECRET,
          email,
          credits: String(credits),
          reference,
        });

        await fetch(url, {
          method: "POST",
          agent: httpsAgent,
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: bodyParams,
        });

        log("✅ Credits applied:", email, credits);
      } catch (err) {
        log("❌ WP credits failed:", err.message);
      }
    });
  }
);

/* =========================
   JSON PARSER (DO NOT MOVE)
========================= */
app.use(express.json());

/* =========================
   VIDEO GENERATION (SAFE MODE + ASYNC)
========================= */
app.post("/generate-video", async (req, res) => {
  try {
    const { prompt, testMode } = req.body;

    if (!prompt)
      return res.status(400).json({ error: "Prompt required" });

    /* SAFE MODE */
    if (SAFE_MODE || testMode === true) {
      const requestId = "test_" + Date.now();

      jobs.set(requestId, { status: "processing" });

      setTimeout(() => {
        jobs.set(requestId, {
          status: "completed",
          videoUrl: "https://sample-videos.com/video123/mp4/720/big_buck_bunny_720p_1mb.mp4"
        });
      }, 5000);

      return res.json({ status: "processing", requestId });
    }

    /* REAL MODE */
    const submit = await fal.queue.submit("fal-ai/ovi", {
      input: { prompt },
    });

    const requestId = submit?.request_id;

    jobs.set(requestId, { status: "processing" });

    processVideo(requestId);

    res.json({ status: "processing", requestId });

  } catch (err) {
    log("❌ Submit failed:", err.message);
    res.status(500).json({ error: "Failed to start generation" });
  }
});

/* =========================
   STATUS ENDPOINT
========================= */
app.get("/video-status/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Not found" });
  res.json(job);
});

/* =========================
   BACKGROUND PROCESSOR
========================= */
async function processVideo(requestId) {
  try {
    const result = await fal.queue.result("fal-ai/ovi", { requestId });

    const videoUrl =
      result?.data?.video?.url ||
      result?.data?.outputs?.[0]?.video?.url;

    jobs.set(requestId, {
      status: "completed",
      videoUrl,
    });

  } catch (err) {
    jobs.set(requestId, {
      status: "failed",
      error: err.message,
    });
  }
}

/* =========================
   START SERVER
========================= */
app.listen(PORT, () => {
  log(`🚀 Calevid backend running on port ${PORT}`);
});