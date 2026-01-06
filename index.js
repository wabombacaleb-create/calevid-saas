import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { fal } from "@fal-ai/client";

// =================================================
// ✅ CONFIG
// =================================================
const app = express();
const PORT = process.env.PORT || 3000;

// Fal.ai configuration
fal.config({
  credentials: process.env.FAL_KEY, // REQUIRED in Render env vars
});

// =================================================
// ✅ MIDDLEWARE
// =================================================
app.use(cors());
app.use(express.json());

// =================================================
// ✅ HEALTH CHECK
// =================================================
app.get("/", (req, res) => {
  res.send("Calevid backend is running");
});

// =================================================
// ✅ PAYSTACK PAYMENT VERIFICATION
// =================================================
app.post("/verify-payment", async (req, res) => {
  const { reference } = req.body;

  if (!reference) {
    return res.status(400).json({
      status: "error",
      message: "Payment reference is required",
    });
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

    const result = await response.json();
    console.log("PAYSTACK RESPONSE:", result);

    if (result.status && result.data.status === "success") {
      return res.json({
        status: "success",
        message: "Payment verified",
        data: {
          amount: result.data.amount,
          currency: result.data.currency,
          email: result.data.customer.email,
          reference: result.data.reference,
        },
      });
    }

    return res.status(400).json({
      status: "failed",
      message: "Payment not successful",
    });
  } catch (error) {
    console.error("PAYSTACK ERROR:", error);
    return res.status(500).json({
      status: "error",
      message: "Server error verifying payment",
    });
  }
});

// =================================================
// ✅ FAL.AI / OVI VIDEO GENERATION (REAL)
// =================================================
app.post("/generate-video", async (req, res) => {
  try {
    const { prompt } = req.body;

    if (!prompt) {
      return res.status(400).json({
        status: "error",
        message: "Prompt is required",
      });
    }

    console.log("VIDEO PROMPT:", prompt);

    const result = await fal.subscribe("fal-ai/ovi", {
      input: {
        prompt: prompt,
      },
    });

    console.log("FAL RESPONSE:", result);

    if (!result?.data?.video?.url) {
      return res.status(500).json({
        status: "error",
        message: "Video generation failed",
      });
    }

    return res.json({
      status: "success",
      videoUrl: result.data.video.url,
      requestId: result.requestId,
    });
  } catch (error) {
    console.error("FAL AI ERROR:", error);

    return res.status(500).json({
      status: "error",
      message: "Fal.ai video generation failed",
      error: error?.message || error,
    });
  }
});

// =================================================
// ✅ SERVER START
// =================================================
app.listen(PORT, () => {
  console.log(`Calevid backend running on port ${PORT}`);
});
