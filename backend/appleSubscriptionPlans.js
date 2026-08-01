// backend/appleSubscriptionPlans.js

export const APPLE_PRODUCT_TO_PLAN = Object.freeze({
  teeradar_basic_monthly: {
    plan: "BASIC",
    billingPeriod: "MONTHLY",
    maxFavs: 3,
  },

  teeradar_basic_annual: {
    plan: "BASIC",
    billingPeriod: "ANNUAL",
    maxFavs: 3,
  },

  teeradar_pro_monthly: {
    plan: "PRO",
    billingPeriod: "MONTHLY",
    maxFavs: 10,
  },

  teeradar_pro_annual: {
    plan: "PRO",
    billingPeriod: "ANNUAL",
    maxFavs: 10,
  },
});

export function getApplePlanDetails(productId) {
  const normalizedProductId = String(productId || "").trim();

  return APPLE_PRODUCT_TO_PLAN[normalizedProductId] || null;
}

export function planFromAppleProduct(productId) {
  return getApplePlanDetails(productId)?.plan || null;
}

export function isAllowedAppleProduct(productId) {
  return !!getApplePlanDetails(productId);
}
