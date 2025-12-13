// backend/stripeRoutes.js
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20", // ok if Stripe ignores / updates this
});

// Map plan names from the frontend → real Stripe price IDs
const PRICE_IDS = {
  BASIC_MONTHLY: "price_1SdnQTASm4geYL4WeBGAEEkA",
  BASIC_ANNUAL:  "price_1SdnRLASm4geYL4W23IKreHO",
  PRO_MONTHLY:   "price_1SdnSGASm4geYL4WBWsFWUNe",
  PRO_ANNUAL:    "price_1SdnSpASm4geYL4W1yxaZf2i",
};

export async function createCheckoutSession(req, res) {
  try {
    const { plan, email } = req.body;

    const priceId = PRICE_IDS[plan];
    if (!priceId) {
      return res.status(400).json({ error: "Invalid plan selected" });
    }

    // ✅ Ensure we store a clean email in Stripe (so Option B portal lookup works)
    const customerEmail =
      email && email.toString().trim() !== ""
        ? email.toString().trim().toLowerCase()
        : undefined;

    // ✅ Single source of truth for where Stripe sends users back
    const successUrl =
      process.env.STRIPE_SUCCESS_URL ||
      "https://teeradar.com.au/subscribe-success.html?session_id={CHECKOUT_SESSION_ID}";
    const cancelUrl =
      process.env.STRIPE_CANCEL_URL ||
      "https://teeradar.com.au/subscribe-cancel.html";

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      customer_email: customerEmail,
      allow_promotion_codes: true,
      success_url: successUrl,
      cancel_url: cancelUrl,
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error("Error creating Stripe Checkout session:", err);
    return res
      .status(500)
      .json({ error: "Unable to create checkout session right now." });
  }
}