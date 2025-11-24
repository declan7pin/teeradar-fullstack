// backend/contact.js
import express from "express";
import nodemailer from "nodemailer";

const contactRouter = express.Router();

/**
 * POST /api/contact
 * Body: { email, question, description }
 */
contactRouter.post("/", async (req, res) => {
  try {
    const { email, question, description } = req.body || {};

    // Basic validation
    if (!email || !question || !description) {
      return res
        .status(400)
        .json({ ok: false, error: "Email, question and description are required." });
    }

    // Very light email sanity check
    if (!email.includes("@") || !email.includes(".")) {
      return res.status(400).json({ ok: false, error: "Please enter a valid email." });
    }

    // Destination: YOUR email, stored as an environment variable
    const toAddress = process.env.CONTACT_TO_EMAIL;
    if (!toAddress) {
      console.error("CONTACT_TO_EMAIL is not set in environment variables.");
      return res
        .status(500)
        .json({ ok: false, error: "Contact system not configured yet." });
    }

    // Configure SMTP transport
    // ⚠️ You will set these as environment vars in Render.
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,         // e.g. "smtp.gmail.com" or your provider
      port: Number(process.env.SMTP_PORT) || 587,
      secure: false,                       // true for 465, false for 587
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    const mailSubject = `TeeRadar contact: ${question.slice(0, 80)}`;
    const mailText = `
New contact enquiry from TeeRadar:

From: ${email}

Question:
${question}

Description:
${description}

---

Reply directly to: ${email}
    `.trim();

    await transporter.sendMail({
      from: `"TeeRadar Contact" <no-reply@teeradar.com.au>`, // shown to user
      to: toAddress,                                        // this is YOUR email
      subject: mailSubject,
      text: mailText,
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error("Contact form error:", err);
    return res.status(500).json({
      ok: false,
      error: "Unable to send your message right now. Please try again later.",
    });
  }
});

export default contactRouter;
