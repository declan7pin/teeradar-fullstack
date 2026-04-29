// backend/contact.js
import express from "express";
import nodemailer from "nodemailer";

const contactRouter = express.Router();

contactRouter.post("/", async (req, res) => {
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

    const toAddress = process.env.CONTACT_TO_EMAIL || "teeradar.help@gmail.com";
    const portNumber = Number(process.env.SMTP_PORT) || 587;

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || "smtp.gmail.com",
      port: portNumber,
      secure: portNumber === 465,
      requireTLS: portNumber === 587,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
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

    console.log("[contact] sending email to:", toAddress);
    console.log("[contact] from:", process.env.SMTP_USER);
    console.log("[contact] replyTo:", email);
    console.log("[contact] subject:", mailSubject);

    await transporter.sendMail({
      from: `"TeeRadar" <${process.env.SMTP_USER}>`,
      to: toAddress,
      replyTo: email,
      subject: mailSubject,
      text: mailText,
    });

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