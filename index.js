import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();

// ✅ Render provides PORT automatically
const PORT = process.env.PORT || 3000;

// ✅ Middleware
app.use(cors());
app.use(express.json());

// ✅ Health check
app.get("/", (req, res) => {
  res.send("Calevid backend is running");
});

// =================================================
// ✅ PAYSTACK PAYMENT VERIFICATION (SAFE MODE)
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
        method: "GET",
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const result = await response.json();

    // ✅ Log for debugging (very important)
    console.log("PAYSTACK VERIFY RESPONSE:", result);

    if (result.status && result.data.status === "success") {
      return res.json({
        status: "success",
        message: "Payment verified successfully",
        data: {
          amount: result.data.amount,
          currency: result.data.currency,
          customer: result.data.customer.email,
          reference: result.data.reference,
        },
      });
    } else {
      return res.status(400).json({
        status: "failed",
        message: "Payment not successful",
        data: result.data,
      });
    }
  } catch (error) {
    console.error("VERIFY PAYMENT ERROR:", error);
    return res.status(500).json({
      status: "error",
      message: "Server error verifying payment",
    });
  }
});

// =================================================
// ✅ VIDEO GENERATION (STILL SAFE / MOCK MODE)
// =================================================
app.post("/generate-video", (req, res) => {
  const { prompt } = req.body;

  if (!prompt) {
    return res.status(400).json({
      status: "error",
      message: "Prompt is required",
    });
  }

  console.log("VIDEO PROMPT RECEIVED:", prompt);

  // ⏳ Simulated video generation
  setTimeout(() => {
    res.json({
      status: "success",
      message: "Video generation simulated (test mode)",
      videoUrl: "https://example.com/sample-video.mp4",
    });
  }, 2000);
});

// =================================================
// ✅ START SERVER
// =================================================
app.listen(PORT, () => {
  console.log(`Calevid backend running on port ${PORT}`);
});
