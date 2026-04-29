// backend/contact.js
import express from "express";
import nodemailer from "nodemailer";

const contactRouter = express.Router();

contactRouter.post("/", async (req, res) => {
  console.log("[contact] route hit");
  console.log("[contact] body:", req.body);

  try {
    const body = req.body || {};

    const email = String(body.email || "").trim();
    const question = String(
      body.question || body.subject || "New TeeRadar enquiry"
    ).trim();

    const description = String(
      body.description || body.message || body.details || ""
    ).trim();

    if (!email || !description) {
      return res.status(400).json({
        ok: false,
        error: "Email and message are required.",
      });
    }

    if (!email.includes("@") || !email.includes(".")) {
      return res.status(400).json({
        ok: false,
        error: "Please enter a valid email.",
      });
    }

    const SMTP_HOST = process.env.SMTP_HOST || "smtp.gmail.com";
    const SMTP_PORT = Number(process.env.SMTP_PORT) || 587;
    const SMTP_USER = process.env.SMTP_USER;
    const SMTP_PASS = process.env.SMTP_PASS;
    const toAddress =
      process.env.CONTACT_TO_EMAIL ||
      process.env.CONTACT_EMAIL ||
      "teeradar.help@gmail.com";

    console.log("[contact env] to:", toAddress);
    console.log("[contact env] host:", SMTP_HOST);
    console.log("[contact env] port:", SMTP_PORT);
    console.log("[contact env] user:", SMTP_USER);
    console.log("[contact env] pass present:", !!SMTP_PASS);

    if (!SMTP_USER || !SMTP_PASS) {
      return res.status(500).json({
        ok: false,
        error: "SMTP_USER or SMTP_PASS missing.",
      });
    }

    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      requireTLS: SMTP_PORT === 587,
      auth: {
        user: SMTP_USER,
        pass: SMTP_PASS,
      },

      // ✅ prevents endless “Sending...”
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
    });

    const isCourseEnquiry = !!body.subject;

    const mailSubject = isCourseEnquiry
      ? `Course enquiry: ${question.slice(0, 80)}`
      : `Golfer contact: ${question.slice(0, 80)}`;

    const mailText = `
New TeeRadar enquiry:

Type: ${isCourseEnquiry ? "Course enquiry" : "Golfer contact"}

From: ${email}

Subject:
${question}

Message:
${description}

---

Reply directly to: ${email}
    `.trim();

    console.log("[contact] verifying SMTP...");
    await transporter.verify();
    console.log("[contact] SMTP verified");

    console.log("[contact] sending email to:", toAddress);

    await transporter.sendMail({
      from: `"TeeRadar" <${SMTP_USER}>`,
      to: toAddress,
      replyTo: email,
      subject: mailSubject,
      text: mailText,
    });

    console.log("[contact] email sent successfully");

    return res.json({ ok: true });
  } catch (err) {
    console.error("Contact form error:", err);
    console.error("Contact form error details:", {
      message: err.message,
      code: err.code,
      command: err.command,
      response: err.response,
      responseCode: err.responseCode,
    });

    return res.status(500).json({
      ok: false,
      error: "Email failed.",
      detail: err.message,
    });
  }
});

export default contactRouter;