import { Resend } from "resend";
import { db, emailEvents } from "../db/index.js";
import { formatMoney } from "./money.js";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const site = () => (process.env.SITE_URL || process.env.URL || "https://islandpay.netlify.app").replace(/\/$/, "");
export const adminEmails = () => (process.env.ADMIN_EMAIL || "").split(",").map((s) => s.trim()).filter(Boolean);

type Row = [string, string];
function layout(title: string, intro: string, rows: Row[] = [], cta?: { label: string; href: string }, footnote?: string) {
  const table = rows.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:18px 0">${rows
        .map(([k, v]) => `<tr><td style="padding:10px 0;border-bottom:1px solid #dde8f1;color:#5d7690;font-size:14px">${esc(k)}</td><td style="padding:10px 0;border-bottom:1px solid #dde8f1;text-align:right;font-weight:700;font-size:14px;color:#0b2540">${esc(v)}</td></tr>`)
        .join("")}</table>`
    : "";
  const button = cta
    ? `<a href="${esc(cta.href)}" style="display:inline-block;background:#0a66b2;background:linear-gradient(135deg,#0a66b2,#19c3d6);color:#fff;text-decoration:none;font-weight:800;padding:14px 26px;border-radius:12px">${esc(cta.label)}</a>`
    : "";
  return `<!doctype html><html><body style="margin:0;background:#eaf3fb;font-family:Inter,Segoe UI,Arial,sans-serif;color:#0b2540">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:20px;overflow:hidden">
<tr><td align="center" style="background:#06223d;background:linear-gradient(160deg,#06223d,#0a66b2 70%,#19c3d6);padding:26px">
<img src="${site()}/icons/icon-192.png" width="96" height="96" alt="Island Pay" style="display:block;border-radius:20px"></td></tr>
<tr><td style="padding:28px">
<h1 style="margin:0 0 10px;font-size:22px">${esc(title)}</h1>
<p style="margin:0;color:#3d5670;font-size:15px;line-height:1.55">${intro}</p>${table}${button}
${footnote ? `<p style="margin:20px 0 0;color:#5d7690;font-size:12px;line-height:1.5">${footnote}</p>` : ""}
</td></tr>
<tr><td style="background:#f2f7fb;padding:16px 28px;color:#5d7690;font-size:11px;line-height:1.5">Island Pay · Pay · Shop · Book · Enjoy<br>Island Pay will never ask for your password, private keys or recovery phrases by email.</td></tr>
</table></td></tr></table></body></html>`;
}

export type DepositInfo = {
  id: string; email: string; currency: string; grossMinor: number; companyFeeMinor: number; customerCreditMinor: number;
  providerOrderId?: string | null; succeededAt?: Date | string | null; createdAt?: Date | string | null; failureReason?: string | null;
};
const when = (d?: Date | string | null) => new Date(d ?? Date.now()).toUTCString();
const depositRows = (d: DepositInfo): Row[] => [
  ["Reference", d.id],
  ["Provider reference", d.providerOrderId || "—"],
  ["Deposit amount", formatMoney(d.grossMinor, d.currency)],
  ["Island Pay fee (8.88%)", formatMoney(d.companyFeeMinor, d.currency)],
  ["Credits (91.12%)", formatMoney(d.customerCreditMinor, d.currency)],
  ["Currency", d.currency],
  ["Date (UTC)", when(d.succeededAt ?? d.createdAt)],
];

export const templates = {
  welcome: (p: { name?: string }) => ({
    subject: "Welcome to Island Pay",
    html: layout(`Welcome${p.name ? ", " + esc(p.name) : ""}!`, "Your Island Pay account has been created. Please confirm your email address using the separate verification email we sent, then log in to buy credits and view your balance.", [], { label: "Open Island Pay", href: site() }),
  }),
  depositSucceeded: (d: DepositInfo) => ({
    subject: `Credits added: ${formatMoney(d.customerCreditMinor, d.currency)} · Island Pay receipt`,
    html: layout("Payment confirmed — credits added", "Your payment was confirmed by our payment provider and the credits below have been added to your Island Pay balance. This email is your transaction receipt.", depositRows(d), { label: "View receipt", href: `${site()}/#receipt/${d.id}` }),
  }),
  depositFailed: (d: DepositInfo) => ({
    subject: "Your Island Pay payment was not completed",
    html: layout("Payment not completed", "Your payment was not completed, so no credits were added and no Island Pay fee was charged.", [...depositRows(d).filter(([k]) => !k.startsWith("Credits") && !k.startsWith("Island")), ["Reason", d.failureReason || "Declined, cancelled or expired by the payment provider"]], { label: "Try again", href: `${site()}/#buy` }),
  }),
  depositReversed: (d: DepositInfo & { kind: string }) => ({
    subject: `Island Pay ${d.kind}: ${formatMoney(d.grossMinor, d.currency)}`,
    html: layout(`Deposit ${esc(d.kind)}`, `A ${esc(d.kind)} was recorded for the deposit below. The related credits were removed from your balance.`, depositRows(d), { label: "View activity", href: `${site()}/#activity` }),
  }),
  adminDeposit: (d: DepositInfo) => ({
    subject: `[Island Pay] New deposit ${formatMoney(d.grossMinor, d.currency)} · revenue ${formatMoney(d.companyFeeMinor, d.currency)}`,
    html: layout("New successful deposit", `Customer ${esc(d.email)} completed a deposit. The 8.88% fee was added to the internal company balance.`, depositRows(d), { label: "Open admin dashboard", href: `${site()}/#admin` }),
  }),
  adminFailed: (d: DepositInfo) => ({
    subject: `[Island Pay] Failed transaction ${d.id.slice(0, 8)}`,
    html: layout("Failed transaction", `A deposit by ${esc(d.email)} failed.`, [...depositRows(d), ["Reason", d.failureReason || "—"]], { label: "Open admin dashboard", href: `${site()}/#admin` }),
  }),
  adminSuspicious: (p: { reason: string; details: Row[] }) => ({
    subject: "[Island Pay] Suspicious transaction alert",
    html: layout("Suspicious transaction alert", esc(p.reason), p.details, { label: "Review now", href: `${site()}/#admin` }, "No funds were credited automatically for mismatched or unverified events."),
  }),
  adminWithdrawal: (p: { status: string; id: string; amountMinor: number; feeMinor: number; currency: string; destination: string; actor: string; reference?: string | null }) => ({
    subject: `[Island Pay] Withdrawal ${p.status}: ${formatMoney(p.amountMinor, p.currency)}`,
    html: layout(`Company withdrawal ${esc(p.status)}`, `Withdrawal action performed by ${esc(p.actor)}.`, [
      ["Withdrawal ID", p.id], ["Amount", formatMoney(p.amountMinor, p.currency)], ["Fee", formatMoney(p.feeMinor, p.currency)],
      ["Destination", p.destination], ["Status", p.status], ["Provider reference", p.reference || "—"], ["Date (UTC)", when()],
    ], { label: "Open admin dashboard", href: `${site()}/#admin` }),
  }),
};

/** Sends via Resend when configured and records every attempt. Never throws. */
export async function sendEmail(to: string | string[], tpl: { subject: string; html: string }, template: string, relatedId?: string) {
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  for (const recipient of recipients) {
    let status = "skipped", providerId: string | null = null, err: string | null = null;
    try {
      if (process.env.RESEND_API_KEY && process.env.EMAIL_FROM) {
        const resend = new Resend(process.env.RESEND_API_KEY);
        const r = await resend.emails.send({ from: process.env.EMAIL_FROM, to: recipient, subject: tpl.subject, html: tpl.html });
        if (r.error) { status = "failed"; err = r.error.message; } else { status = "sent"; providerId = r.data?.id ?? null; }
      } else {
        err = "Resend is not configured (RESEND_API_KEY / EMAIL_FROM)";
      }
    } catch (e: any) {
      status = "failed"; err = String(e?.message || e);
    }
    try {
      await db.insert(emailEvents).values({ recipient, template, relatedId: relatedId ?? null, status, providerId, error: err });
    } catch (e) {
      console.error("email log failed", e);
    }
  }
}
