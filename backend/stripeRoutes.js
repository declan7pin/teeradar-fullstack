// backend/stripeRoutes.js
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
});

// Map plan names from the frontend → real Stripe price IDs
const PRICE_IDS = {
  BASIC_MONTHLY: "price_1ScbpVASm4geYL4WJmSABxlb",
  BASIC_ANNUAL:  "price_1Scbq9ASm4geYL4WyjPjX8Go",
  PRO_MONTHLY:   "price_1ScbklASm4geYL4WPpbT6PtL",
  PRO_ANNUAL:    "price_1ScbmCASm4geYL4W0EQZBrvf",
};

function normalizePlanKey(plan) {
  return String(plan || "").trim().toUpperCase();
}

function derivePlanName(planKey) {
  if (planKey.startsWith("PRO_")) return "PRO";
  if (planKey.startsWith("BASIC_")) return "BASIC";
  return "FREE";
}

export async function createCheckoutSession(req, res) {
  try {
    const { plan, email, userId } = req.body;

    const planKey = normalizePlanKey(plan);
    const priceId = PRICE_IDS[planKey];

    if (!priceId) {
      return res.status(400).json({ error: "Invalid plan selected" });
    }

    const customerEmail =
      email && String(email).trim() !== "" ? String(email).trim() : undefined;

    const planName = derivePlanName(planKey);

    const baseUrl =
      process.env.PUBLIC_BASE_URL ||
      process.env.APP_URL ||
      "http://localhost:3000";

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

      // These are important for webhook reconciliation later
      client_reference_id: userId ? String(userId) : undefined,

      metadata: {
        planKey,
        planName,
        email: customerEmail || "",
        userId: userId ? String(userId) : "",
      },

      subscription_data: {
        metadata: {
          planKey,
          planName,
          email: customerEmail || "",
          userId: userId ? String(userId) : "",
        },
      },

      success_url: `${baseUrl}/subscribe-success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/subscribe-cancel.html`,
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error("Error creating Stripe Checkout session:", err);
    return res
      .status(500)
      .json({ error: "Unable to create checkout session right now." });
  }
}

export { stripe };
