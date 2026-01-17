import express from "express";
import cors from "cors";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import { fal } from "@fal-ai/client";

// =================================================
// CONFIG
// =================================================
const app = express();
const PORT = process.env.PORT || 10000;
const WP_SITE_URL = process.env.WP_SITE_URL;

// =================================================
// GLOBAL MIDDLEWARE
// =================================================
app.use(cors());

// Only parse JSON for non-webhook routes
app.use((req, res, next) => {
  if (req.originalUrl === "/paystack-webhook") return next();
  express.json()(req, res, next);
});

// Raw body for webhook route
app.use("/paystack-webhook", express.raw({ type: "application/json" }));

// =================================================
// FAL.AI CONFIG
// =================================================
fal.config({ credentials: process.env.FAL_KEY });

// =================================================
// LOGGING
// =================================================
function logWebhook(message, data = {}) {
  console.log(message, data);
}

// =================================================
// HEALTH
// =================================================
app.get("/", (req, res) => res.send("Calevid backend is running"));
app.get("/status/test", (req, res) =>
  res.json({ status: "Node backend is running" })
);

// =================================================
// PAYSTACK WEBHOOK
// =================================================
app.post("/paystack-webhook", async (req, res) => {
  const bodyString = req.body.toString("utf8");

  const TEST_BYPASS = process.env.TEST_WEBHOOK_BYPASS === "true";

  if (!TEST_BYPASS) {
    const secret = process.env.PAYSTACK_SECRET_KEY;
    if (!secret) return res.sendStatus(500);

    const signature = req.headers["x-paystack-signature"] || "";
    const hash = crypto
      .createHmac("sha512", secret)
      .update(bodyString)
      .digest("hex");

    if (hash !== signature) {
      logWebhook("Invalid signature");
      return res.status(401).send("Invalid signature");
    }
  }

  let event;
  try {
    event = JSON.parse(bodyString);
  } catch {
    return res.sendStatus(400);
  }

  if (event.event !== "charge.success") return res.sendStatus(200);

  const data = event.data;
  const reference = data.reference;
  const email = data.customer.email;
  const amountKes = data.amount / 100;

  const credits = Math.floor(amountKes / 150);

  try {
    // 🔹 keep existing verification (unchanged)
    await fetch(`${WP_SITE_URL}/wp-admin/admin-ajax.php`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "calevid_verify_payment",
        reference,
      }),
    });

    // 🔹 ADD credits (THIS WAS MISSING)
    await fetch(`${WP_SITE_URL}/wp-admin/admin-ajax.php?action=calevid_apply_credits`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret: process.env.CALEVID_WEBHOOK_SECRET,
        email,
        credits,
        reference,
      }),
    });

    logWebhook("Webhook processed", {
      reference,
      email,
      amountKes,
      credits,
    });

    return res.sendStatus(200);
  } catch (err) {
    logWebhook("Webhook error", err);
    return res.sendStatus(500);
  }
});

// =================================================
// VERIFY PAYMENT
// =================================================
app.post("/verify-payment", (req, res) => {
  const { reference } = req.body;
  if (!reference)
    return res.status(400).json({ status: "error", message: "Reference required" });

  return res.json({
    status: "pending",
    message: "Payment received, awaiting credit",
    reference,
  });
});

// =================================================
// VIDEO GENERATION
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
      return res.status(500).json({ status: "error", message: "Video URL not found" });

    return res.json({ status: "success", videoUrl });
  } catch {
    return res.status(500).json({ status: "error", message: "Fal.ai failed" });
  }
});

// =================================================
// START
// =================================================
app.listen(PORT, () =>
  console.log(`Calevid backend running on port ${PORT}`)
);
