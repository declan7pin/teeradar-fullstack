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

    // Fallback email in case you don't send one yet
    const customerEmail = email && email.trim() !== "" ? email : undefined;

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

      // TODO: replace YOUR_DOMAIN with your test/prod URL
      success_url:
        "https://teeradar.com.au/subscribe-success.html?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: "https://teeradar.com.au/subscribe-cancel.html",
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error("Error creating Stripe Checkout session:", err);
    return res
      .status(500)
      .json({ error: "Unable to create checkout session right now." });
  }
}
