import express from "express";
import cors from "cors";
import crypto from "crypto";
import fetch from "node-fetch";
import { fal } from "@fal-ai/client";

// =================================================
// CONFIG
// =================================================
const app = express();
const PORT = process.env.PORT || 10000;
const WP_SITE_URL = process.env.WP_SITE_URL;

// =================================================
// MIDDLEWARE
// =================================================
app.use(cors());

// IMPORTANT: webhook must receive RAW body
app.use("/paystack-webhook", express.raw({ type: "*/*" }));

// Normal JSON for other routes
app.use(express.json());

// =================================================
// FAL.AI CONFIG
// =================================================
fal.config({ credentials: process.env.FAL_KEY });

// =================================================
// SIMPLE RENDER LOGGING (CRITICAL)
// =================================================
function log(message, data = null) {
  console.log(
    `[${new Date().toISOString()}] ${message}`,
    data ? data : ""
  );
}

// =================================================
// HEALTH
// =================================================
app.get("/", (req, res) => {
  log("Health check hit");
  res.send("Calevid backend is running");
});

app.get("/status/test", (req, res) => {
  res.json({ status: "Node backend is running" });
});

// =================================================
// PAYSTACK WEBHOOK (FINAL FIX)
// =================================================
app.post("/paystack-webhook", (req, res) => {
  log("🔥 PAYSTACK WEBHOOK HIT");

  const bodyBuffer = req.body;
  const bodyString = bodyBuffer.toString("utf8");

  // ALWAYS ACK PAYSTACK IMMEDIATELY
  res.sendStatus(200);

  // -----------------------------
  // VERIFY SIGNATURE
  // -----------------------------
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) {
    log("❌ PAYSTACK_SECRET_KEY missing");
    return;
  }

  const signature = req.headers["x-paystack-signature"];
  const hash = crypto
    .createHmac("sha512", secret)
    .update(bodyBuffer)
    .digest("hex");

  if (hash !== signature) {
    log("❌ Invalid Paystack signature");
    return;
  }

  let event;
  try {
    event = JSON.parse(bodyString);
  } catch (err) {
    log("❌ Invalid JSON payload", err.message);
    return;
  }

  log("Webhook event received", event.event);

  if (event.event !== "charge.success") {
    log("Ignored event type", event.event);
    return;
  }

  const data = event.data;
  const reference = data.reference;
  const email = data.customer?.email;
  const amountKes = data.amount / 100;
  const credits = Math.floor(amountKes / 150);

  if (!email || credits <= 0) {
    log("❌ Invalid credit calculation", { email, credits });
    return;
  }

  log("Processing credits", { email, credits, reference });

  // -----------------------------
  // SEND TO WORDPRESS (ASYNC)
  // -----------------------------
  setImmediate(async () => {
    try {
      const response = await fetch(
        `${WP_SITE_URL}/wp-admin/admin-ajax.php?action=calevid_apply_credits`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            secret: process.env.CALEVID_WEBHOOK_SECRET,
            email,
            credits: String(credits),
            reference,
          }),
        }
      );

      const text = await response.text();

      log("✅ WordPress response", {
        status: response.status,
        body: text,
      });
    } catch (err) {
      log("❌ WordPress request failed", err.message);
    }
  });
});

// =================================================
// VERIFY PAYMENT (UNCHANGED)
// =================================================
app.post("/verify-payment", (req, res) => {
  const { reference } = req.body;
  if (!reference) {
    return res.status(400).json({
      status: "error",
      message: "Reference required",
    });
  }

  return res.json({
    status: "pending",
    message: "Payment received, awaiting credit",
    reference,
  });
});

// =================================================
// VIDEO GENERATION (UNCHANGED)
// =================================================
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
        message: "Video generation failed",
      });
    }

    return res.json({
      status: "success",
      videoUrl,
      requestId: result.requestId,
    });
  } catch (err) {
    return res.status(500).json({
      status: "error",
      message: "Generation failed",
    });
  }
});

// =================================================
// START SERVER
// =================================================
app.listen(PORT, () => {
  log(`🚀 Calevid backend running on port ${PORT}`);
});
