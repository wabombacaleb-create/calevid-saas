/**
 * paystack-webhook.js
 * Production-ready Paystack webhook for Calevid SaaS
 * Fully replaces PHP webhook
 */

import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";
import path from "path";

// WordPress path (adjust if needed)
const WP_PATH = path.resolve("./wp-load.php");

const router = express.Router();

// Middleware to parse raw body for HMAC verification
router.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf.toString();
    },
  })
);

router.post("/paystack-webhook", async (req, res) => {
  const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
  const signature = req.headers["x-paystack-signature"] || "";

  // Validate signature
  const hash = crypto
    .createHmac("sha512", PAYSTACK_SECRET_KEY)
    .update(req.rawBody)
    .digest("hex");

  if (!crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(signature))) {
    console.warn("Invalid Paystack signature");
    return res.status(401).send("Invalid signature");
  }

  const event = req.body;

  // Only handle successful charges
  if (!event || event.event !== "charge.success") {
    return res.status(200).send("Event ignored");
  }

  const data = event.data;
  const reference = data.reference;

  // Load WordPress environment
  try {
    await import(WP_PATH);
  } catch (err) {
    console.error("WP load failed:", err);
    return res.status(500).send("WP not loaded");
  }

  // Identify user by email
  const email = data.customer.email;
  const user = global.wp?.get_user_by
    ? global.wp.get_user_by("email", email)
    : null;

  if (!user) {
    console.warn(`User not found for email: ${email}`);
    return res.status(200).send("User not found");
  }

  const userId = user.ID;
  const txKey = `calevid_tx_${reference}`;

  // Prevent duplicate processing
  if (global.wp?.get_user_meta?.(userId, txKey, true)) {
    console.log(`Transaction ${reference} already processed`);
    return res.status(200).send("Already processed");
  }

  // Calculate credits
  const amountKES = data.amount / 100; // Paystack sends kobo
  const CREDIT_PRICE_KES = 150;
  const creditsToAdd = Math.floor(amountKES / CREDIT_PRICE_KES);

  if (creditsToAdd <= 0) {
    console.warn(`Payment too low: KSh ${amountKES} for user ${userId}`);
    return res.status(200).send("Payment insufficient");
  }

  // Apply credits
  const currentCredits =
    global.wp?.get_user_meta?.(userId, "calevid_credits", true) || 0;
  global.wp?.update_user_meta?.(
    userId,
    "calevid_credits",
    currentCredits + creditsToAdd
  );

  // Lock transaction
  global.wp?.update_user_meta?.(userId, txKey, {
    time: Date.now(),
    amount_kes: amountKES,
    credits_added: creditsToAdd,
  });

  // Remove pending purchase
  global.wp?.delete_user_meta?.(userId, "calevid_pending_purchase");

  console.log(
    `Credits applied: ${creditsToAdd} to user ${userId} for transaction ${reference}`
  );

  res.status(200).send("Webhook processed successfully");
});

export default router;
