
import express from "express";
import cors from "cors";
import crypto from "crypto";
import fetch from "node-fetch";
import https from "https";
import dns from "dns";
import { fal } from "@fal-ai/client";
import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { GetObjectCommand } from "@aws-sdk/client-s3";

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
const API_KEY = process.env.CALEVID_API_KEY || process.env.API_KEY || "";
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || "";
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || "";
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || "";
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || "calevid-videos";
const R2_ENDPOINT = process.env.R2_ENDPOINT || (R2_ACCOUNT_ID ? `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : "");
const R2_READY = Boolean(R2_ENDPOINT && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET_NAME);
const r2 = R2_READY ? new S3Client({
  region: "auto",
  endpoint: R2_ENDPOINT,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
}) : null;

const FAL_VIDEO_MODEL = "minimax/h3-max-turbo/text-to-video";

fal.config({
  credentials: process.env.FAL_KEY,
});

const SAFE_MODE = String(process.env.SAFE_MODE).toLowerCase() === "true";

console.log("ENV SAFE_MODE:", process.env.SAFE_MODE);
console.log("PARSED SAFE_MODE:", SAFE_MODE);

/* =========================
   GLOBAL MIDDLEWARE
========================= */
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || "https://calevid.com" }));

const httpsAgent = new https.Agent({
  keepAlive: false,
  rejectUnauthorized: true,
  family: 4,
});

const log = (...args) =>
  console.log(`[${new Date().toISOString()}]`, ...args);

// All WordPress-to-backend video and signed-URL operations require the shared API key.
function requireApiKey(req, res, next) {
  const supplied = String(req.headers["x-api-key"] || "");
  if (!API_KEY || !supplied || supplied.length !== API_KEY.length ||
      !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(API_KEY))) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

async function saveFalVideoToR2(requestId, sourceUrl) {
  if (!R2_READY) throw new Error("Video storage is not configured on the backend");
  const key = `videos/${requestId}.mp4`;
  try {
    await r2.send(new HeadObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }));
  } catch (err) {
    if (err?.$metadata?.httpStatusCode !== 404 && err?.name !== "NotFound" && err?.name !== "NoSuchKey") throw err;
    const download = await fetch(sourceUrl, { signal: AbortSignal.timeout(120000) });
    if (!download.ok) throw new Error(`Fal video download failed (${download.status})`);
    const bytes = Buffer.from(await download.arrayBuffer());
    if (!bytes.length) throw new Error("Fal returned an empty video file");
    await r2.send(new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
      Body: bytes,
      ContentType: "video/mp4",
      ContentLength: bytes.length,
      Metadata: { requestid: requestId },
    }));
  }
  return key;
}


async function createVideoUrl(key, download = false) {
  if (!R2_READY) {
    throw new Error("Video storage is not configured on the backend");
  }

  if (
    typeof key !== "string" ||
    !/^videos\/[A-Za-z0-9_-]{5,160}\.mp4$/.test(key)
  ) {
    throw new Error("Invalid video storage key");
  }

  const command = new GetObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
    ...(download
      ? {
          ResponseContentDisposition:
            'attachment; filename="calevid-video.mp4"',
        }
      : {}),
  });

  return getSignedUrl(r2, command, { expiresIn: 3600 });
}

/* =========================
   HEALTH CHECK
========================= */
app.get("/", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

/* =========================
   PAYSTACK WEBHOOK
========================= */
app.post(
  "/paystack-webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const body = req.body;
    const signature = req.headers["x-paystack-signature"];
    if (!signature || !PAYSTACK_SECRET || !WEBHOOK_SECRET || !WP_SITE_URL) {
      log("Webhook configuration missing");
      return res.sendStatus(503);
    }

    const expected = crypto.createHmac("sha512", PAYSTACK_SECRET).update(body).digest();
    let received;
    try { received = Buffer.from(String(signature), "hex"); } catch { return res.sendStatus(401); }
    if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
      log("Invalid Paystack webhook signature");
      return res.sendStatus(401);
    }

    let event;
    try { event = JSON.parse(body.toString("utf8")); }
    catch { return res.sendStatus(400); }

    const supportedEvents = ["charge.success", "invoice.payment_success"];
    if (!supportedEvents.includes(event?.event) || (event?.event === "charge.success" && event?.data?.status !== "success")) {
      return res.sendStatus(200);
    }

    const data = event.data || {};
    const metadata = data.metadata || {};
    const reference = String(data.reference || data.transaction?.reference || data.invoice_code || "");
    const email = String(data.customer?.email || data.customer?.customer_code && data.customer?.email || "").trim().toLowerCase();
    const planCode = String(metadata.plan_code || data.plan?.plan_code || data.subscription?.plan?.plan_code || data.plan_code || "");
    const isSubscriptionPayment = Boolean(
  metadata.type === "subscription" ||
  data.subscription ||
  event.event === "invoice.payment_success"
);

    // Match the original integration: one-off subscription checkout events are
    // handled by WordPress and must never be converted into credit purchases.
    if (event.event === "charge.success" && (metadata.type === "subscription" || metadata.plan_code)) {
      log("Subscription charge handled by WordPress; skipping credit application");
      return res.sendStatus(200);
    }

    try {
      let endpoint;
      let params;
      if (planCode || isSubscriptionPayment) {
        if (!planCode || !reference || !email) {
          log("Subscription webhook is missing its plan code, reference, or customer email");
          return res.sendStatus(400);
        }
        endpoint = "apply-subscription-credits";
        params = new URLSearchParams({ secret: WEBHOOK_SECRET, email, plan_code: planCode, reference });
      } else {
        if (event?.event !== "charge.success") return res.sendStatus(200);
        // Preserve compatibility with the original dashboard checkout, which does not
        // attach calevid_purchase metadata. Subscription transactions are routed above.
        // This webhook endpoint is dedicated to Calevid Paystack payments.
        const amountKobo = Number(data.amount || 0);
        const priceKobo = 99 * 100;
        if (String(data.currency || "").toUpperCase() !== "KES" || !reference || !email || !Number.isSafeInteger(amountKobo) || amountKobo <= 0 || amountKobo % priceKobo !== 0) {
          log("Invalid credit payment payload");
          return res.sendStatus(400);
        }
        const credits = amountKobo / priceKobo;
        endpoint = "apply-credits";
        params = new URLSearchParams({ secret: WEBHOOK_SECRET, email, credits: String(credits), reference });
      }

      const response = await fetch(`${WP_SITE_URL}/wp-json/calevid/v1/${endpoint}`, {
        method: "POST",
        agent: httpsAgent,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params,
        signal: AbortSignal.timeout(90000),
      });
      const result = await response.text();
      if (!response.ok) {
        log("WordPress rejected payment credit application", response.status, result.slice(0, 300));
        return res.sendStatus(500); // Ask Paystack to retry the webhook.
      }
      log(`Paystack payment processed; event=${event.event}; reference=${reference}`);
      return res.sendStatus(200);
    } catch (err) {
      log("WordPress credit application failed:", err.message);
      return res.sendStatus(500);
    }
  }
);

/* =========================
   JSON PARSER (DO NOT MOVE)
========================= */
app.use(express.json());

/* =========================
   VIDEO GENERATION - MINIMAX H3 MAX TURBO
========================= */

// Generate video
app.post("/generate-video", async (req, res) => {
  try {
    const { prompt, testMode } = req.body;

    if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
      return res.status(400).json({ error: "Prompt required" });
    }

    const duration = Number(req.body.duration ?? 5);

    if (![5, 10, 15].includes(duration)) {
      return res.status(400).json({
        error: "Invalid duration. Choose 5, 10 or 15 seconds."
      });
    }

    // SAFE MODE / TEST MODE
    if (SAFE_MODE || testMode === true) {
      const requestId = "test_" + Date.now();

      return res.json({
        status: "processing",
        requestId,
        duration
      });
    }

    // Submit video generation to Fal AI
    const submit = await fal.queue.submit(FAL_VIDEO_MODEL, {
      input: {
        prompt: prompt.trim(),
        duration,
        resolution: "768P",
        prompt_expansion_mode: "balanced",
        enable_safety_checker: true
      }
    });

    const requestId = submit?.request_id;

    if (!requestId) {
      throw new Error("No request_id returned from Fal");
    }

    log("Video submitted:", {
      requestId,
      duration
    });

    return res.json({
      status: "processing",
      requestId,
      duration
    });

  } catch (err) {
    console.error("❌ Submit failed:", err.message);

    return res.status(500).json({
      error: "Failed to start generation"
    });
  }
});


/* =========================================
   VIDEO STATUS — FAL-AUTHORITATIVE CHECK
========================================= */

app.get("/video-status/:id", requireApiKey, async (req, res) => {
  const requestId = String(req.params.id || "");

  if (!/^[A-Za-z0-9_-]{5,160}$/.test(requestId)) {
    return res.status(400).json({
      error: "Invalid request ID"
    });
  }

  try {
    /* -------------------------------------
       TEST MODE
    ------------------------------------- */

    if (requestId.startsWith("test_")) {
      const createdAt = parseInt(requestId.split("_")[1], 10);

      if (!Number.isFinite(createdAt)) {
        return res.status(400).json({
          error: "Invalid test request ID"
        });
      }

      if (Date.now() - createdAt > 5000) {
        return res.json({
          status: "completed",
          videoUrl: "https://www.w3schools.com/html/mov_bbb.mp4",
          testMode: true
        });
      }

      return res.json({
        status: "processing",
        testMode: true
      });
    }

    /* -------------------------------------
       1. CHECK ACTUAL FAL JOB STATUS
    ------------------------------------- */

    let falStatus;

    try {
      falStatus = await fal.queue.status(
        FAL_VIDEO_MODEL,
        { requestId }
      );
    } catch (statusError) {
      log("Fal status check unavailable:", {
        requestId,
        error: statusError.message
      });

      // A failed status check does NOT mean
      // that Fal has failed the generation.
      return res.json({
        status: "processing",
        stage: "checking_provider"
      });
    }

    const providerStatus = falStatus?.status;

    /* -------------------------------------
       2. FAL IS STILL PROCESSING
    ------------------------------------- */

    if (
      providerStatus === "IN_QUEUE" ||
      providerStatus === "IN_PROGRESS"
    ) {
      return res.json({
        status: "processing",
        falStatus: providerStatus
      });
    }

    /* -------------------------------------
       3. ONLY CONFIRMED FAL FAILURE
       IS TREATED AS GENERATION FAILURE
    ------------------------------------- */

    if (
      providerStatus === "COMPLETED" &&
      (falStatus?.error || falStatus?.error_type)
    ) {
      log("Fal confirmed generation failure:", {
        requestId,
        error: falStatus.error || falStatus.error_type
      });

      return res.status(503).json({
        status: "failed",
        error: "Fal confirmed that video generation failed.",
        provider: "fal"
      });
    }

    /* -------------------------------------
       4. UNKNOWN OR UNCONFIRMED STATUS
       MUST NOT TRIGGER A REFUND
    ------------------------------------- */

    if (providerStatus !== "COMPLETED") {
      log("Fal returned an unconfirmed status:", {
        requestId,
        falStatus: providerStatus
      });

      return res.json({
        status: "processing",
        stage: "awaiting_provider_confirmation"
      });
    }

    /* -------------------------------------
       5. FAL COMPLETED — RETRIEVE RESULT
    ------------------------------------- */

    let result;

    try {
      result = await fal.queue.result(
        FAL_VIDEO_MODEL,
        { requestId }
      );
    } catch (resultError) {
      log("Fal result retrieval pending:", {
        requestId,
        error: resultError.message
      });

      // Do not refund. The result may still
      // be retrievable.
      return res.json({
        status: "processing",
        stage: "retrieving_result"
      });
    }

    const sourceUrl = result?.data?.video?.url;

    if (!sourceUrl) {
      log("Fal completed but returned no video URL:", {
        requestId
      });

      return res.json({
        status: "processing",
        stage: "awaiting_video_result"
      });
    }

    /* -------------------------------------
       6. SAVE SUCCESSFUL VIDEO TO R2
    ------------------------------------- */

    let storageKey;

    try {
      storageKey = await saveFalVideoToR2(
        requestId,
        sourceUrl
      );
    } catch (storageError) {
      log("R2 video storage failed:", {
        requestId,
        error: storageError.message
      });

      // Storage failure is NOT Fal generation
      // failure. Keep the job recoverable.
      return res.json({
        status: "processing",
        stage: "saving_video"
      });
    }

    /* -------------------------------------
       7. CREATE SECURE VIDEO URL
    ------------------------------------- */

    
    /* -------------------------------------
       7. CREATE SECURE VIDEO URLS
    ------------------------------------- */

    let videoUrl;
    let downloadUrl;

    try {
      videoUrl = await createVideoUrl(storageKey);
      downloadUrl = await createVideoUrl(storageKey, true);
    } catch (urlError) {
      log("Video URL creation failed:", {
        requestId,
        error: urlError.message
      });

      return res.json({
        status: "processing",
        stage: "creating_video_url"
      });
    }

    /* -------------------------------------
       8. CONFIRMED SUCCESS
    ------------------------------------- */

    return res.json({
      status: "completed",
      videoUrl,
      downloadUrl,
      storageKey
    });

  } catch (error) {
    log("Video status endpoint error:", {
      requestId,
      error: error.message
    });

    // Unexpected errors must not cause refunds.
    return res.json({
      status: "processing"
    });
  }
});


app.get("/video-url", requireApiKey, async (req, res) => {
  try {
    const key = String(req.query.key || "");
    const download = req.query.download === "1";

    const videoUrl = await createVideoUrl(key, download);

    return res.json({
      videoUrl,
      expiresIn: 3600
    });
  } catch (err) {
    log("Signed URL error:", err.message);
    return res.status(400).json({
      error: "Unable to create video download link"
    });
  }
});

app.get("/video-url/*", requireApiKey, async (req, res) => {
  try {
    const key = decodeURIComponent(req.params[0] || "");
    const download = req.query.download === "1";

    const videoUrl = await createVideoUrl(key, download);

    return res.json({
      videoUrl,
      expiresIn: 3600
    });
  } catch (err) {
    log("Signed URL error:", err.message);
    return res.status(400).json({
      error: "Unable to create video download link"
    });
  }
});
/* =========================
   SAFE_MODE video endpoint
========================= */
app.get("/video.mp4", async (req, res) => {
  if (!SAFE_MODE) return res.sendStatus(404);
  try {
    const response = await fetch("https://www.w3schools.com/html/mov_bbb.mp4");
    if (!response.ok) return res.status(500).send("Failed to fetch test video");

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Access-Control-Allow-Origin", "*");
    response.body.pipe(res);
  } catch (err) {
    console.error("Video test error:", err.message);
    res.status(500).send("Video test failed");
  }
});

/* =========================
   START SERVER
========================= */
app.listen(PORT, () => {
  log(`🚀 Calevid backend running on port ${PORT}`);
});
