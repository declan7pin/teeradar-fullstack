// backend/contact.js
import express from "express";
import nodemailer from "nodemailer";

const contactRouter = express.Router();

contactRouter.post("/", async (req, res) => {
  try {
    const body = req.body || {};

    const email = String(body.email || "").trim();
    const question = String(body.question || body.subject || "New TeeRadar enquiry").trim();
    const description = String(body.description || body.message || body.details || "").trim();

    if (!email || !description) {
      return res.status(400).json({
        ok: false,
        error: "Email and message are required."
      });
    }

    if (!email.includes("@") || !email.includes(".")) {
      return res.status(400).json({
        ok: false,
        error: "Please enter a valid email."
      });
    }

    const toAddress = process.env.CONTACT_TO_EMAIL || "TeeRadar.help@gmail.com";

    const portNumber = Number(process.env.SMTP_PORT) || 587;

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: portNumber,
      secure: portNumber === 465,
      requireTLS: portNumber === 587,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    const mailSubject = `TeeRadar enquiry: ${question.slice(0, 80)}`;

    const mailText = `
New TeeRadar enquiry:

From: ${email}

Subject:
${question}

Message:
${description}

---

Reply directly to: ${email}
    `.trim();

    await transporter.sendMail({
      from: `"TeeRadar Contact" <${process.env.SMTP_USER}>`,
      to: toAddress,
      replyTo: email,
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