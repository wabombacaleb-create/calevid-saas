import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();

// IMPORTANT: Render provides PORT automatically
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Root check
app.get("/", (req, res) => {
  res.send("Calevid backend is running");
});

/**
 * STEP 1: Verify Paystack payment
 */
app.post("/verify-payment", async (req, res) => {
  const { reference } = req.body;

  if (!reference) {
    return res.status(400).json({ error: "Payment reference is required" });
  }

  try {
    const response = await fetch(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const data = await response.json();

    if (
      data.status === true &&
      data.data.status === "success" &&
      data.data.currency === "KES"
    ) {
      return res.json({
        status: "success",
        message: "Payment verified successfully",
        reference: data.data.reference,
        amount: data.data.amount / 100, // Paystack uses kobo
        email: data.data.customer.email,
      });
    }

    return res.status(400).json({
      status: "failed",
      message: "Payment verification failed",
    });
  } catch (error) {
    return res.status(500).json({
      status: "error",
      message: error.message,
    });
  }
});

/**
 * STEP 2: Generate video (locked behind payment)
 */
app.post("/generate-video", async (req, res) => {
  const { prompt, paymentVerified } = req.body;

  if (!paymentVerified) {
    return res.status(403).json({
      error: "Payment not verified. Please pay before generating video.",
    });
  }

  if (!prompt) {
    return res.status(400).json({ error: "Prompt is required" });
  }

  console.log("Generating video for prompt:", prompt);

  // TEST MODE — Fal.ai will be added next step
  setTimeout(() => {
    res.json({
      status: "success",
      message: "Video generation simulated (test mode)",
      prompt,
      videoUrl: "https://example.com/sample-video.mp4",
    });
  }, 2000);
});

app.listen(PORT, () => {
  console.log(`Calevid backend running on port ${PORT}`);
});
