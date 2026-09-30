// api/_lib/notify.js
//
// Shared helper that sends customer notifications for an order over email (Resend)
// and WhatsApp (Meta Cloud API). The leading underscore in "_lib" means Vercel does
// NOT expose this file as a public URL — it can only be used by other API files.
//
// Each channel switches itself on only when its environment variables exist:
//   Email:     RESEND_API_KEY
//   WhatsApp:  WHATSAPP_TOKEN + WHATSAPP_PHONE_NUMBER_ID
// Missing keys = that channel is skipped and logged as "skipped", never faked.
//
// Every attempt is written to the notification_log table so the admin can see
// what went out and what failed. A notification failure never throws back into
// payment or shipping logic.

const FROM_EMAIL = 'Laiza Lifestyle <orders@laizalifestyle.com>';
const REPLY_TO = 'laizalifestyle@gmail.com';
const SITE_URL = 'https://laizalifestyle.com';

// WhatsApp template names — must match the names approved in Meta exactly.
const WA_TEMPLATES = {
  confirmed: 'order_confirmed',
  shipped: 'order_shipped',
  delivered: 'order_delivered'
};

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

// Numbers (order no., amount, AWB) are shown in Arial so they read as plain,
// straight digits instead of the serif email font's old-style numerals.
const NUM_STYLE = 'font-family:Arial,Helvetica,sans-serif';
function num(s) {
  return `<span style="${NUM_STYLE}">${escapeHtml(s)}</span>`;
}

function money(n) {
  return '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

function buildEmail(event, o) {
  const name = escapeHtml(o.name);
  const orderNo = num(o.order_number);
  let subject, heading, body;

  if (event === 'confirmed') {
    subject = `Order ${o.order_number} confirmed — Laiza Lifestyle`;
    heading = 'Thank you for your order!';
    body = `
      <p>Hi ${name},</p>
      <p>Your order <strong>${orderNo}</strong> is confirmed and being prepared.</p>
      <p style="font-size:18px;margin:20px 0"><strong>Total: ${num(money(o.total))}</strong></p>
      <p>We'll email you again with a tracking link as soon as it ships.</p>`;
  } else if (event === 'shipped') {
    subject = `Your order ${o.order_number} has shipped — Laiza Lifestyle`;
    heading = 'Your order is on its way';
    body = `
      <p>Hi ${name},</p>
      <p>Your order <strong>${orderNo}</strong> has shipped via <strong>${escapeHtml(o.courier_name || 'our courier partner')}</strong>.</p>
      ${o.awb_code ? `<p>Tracking number (AWB): <strong>${num(o.awb_code)}</strong></p>` : ''}
      ${o.tracking_url ? `<p style="margin:24px 0"><a href="${escapeHtml(o.tracking_url)}" style="background:#1a1a1a;color:#fff;padding:12px 22px;text-decoration:none;border-radius:4px;display:inline-block">Track your order</a></p>` : ''}`;
  } else if (event === 'delivered') {
    subject = `Order ${o.order_number} delivered — Laiza Lifestyle`;
    heading = 'Delivered!';
    body = `
      <p>Hi ${name},</p>
      <p>Your order <strong>${orderNo}</strong> has been delivered. We hope you love it.</p>
      <p>Thank you for shopping with Laiza Lifestyle.</p>`;
  } else {
    return null;
  }

  const html = `<!doctype html><html><body style="margin:0;background:#f5f3ef;font-family:Georgia,'Times New Roman',serif;color:#1a1a1a">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px"><tr><td align="center">
    <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:6px;overflow:hidden">
      <tr><td style="background:#1a1a1a;color:#fff;padding:20px 28px;font-size:22px;letter-spacing:4px">LAIZA</td></tr>
      <tr><td style="padding:28px;font-size:15px;line-height:1.6">
        <h2 style="margin:0 0 16px;font-weight:normal">${heading}</h2>
        ${body}
        <p style="margin-top:28px;color:#666;font-size:13px">Questions? Just reply to this email.</p>
      </td></tr>
      <tr><td style="padding:16px 28px;background:#faf8f5;color:#888;font-size:12px">
        Laiza Lifestyle · Sagar, Karnataka · <a href="${SITE_URL}" style="color:#888">laizalifestyle.com</a>
      </td></tr>
    </table>
  </td></tr></table></body></html>`;

  return { subject, html };
}

function waParams(event, o) {
  if (event === 'confirmed') return [o.name, o.order_number, String(Number(o.total || 0))];
  if (event === 'shipped') return [o.name, o.order_number, o.courier_name || 'our courier', o.tracking_url || SITE_URL];
  if (event === 'delivered') return [o.name, o.order_number];
  return null;
}

async function sendEmail(to, event, o) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { status: 'skipped', detail: 'RESEND_API_KEY not set' };
  if (!to) return { status: 'skipped', detail: 'no customer email on file' };
  const mail = buildEmail(event, o);
  if (!mail) return { status: 'skipped', detail: `no email template for ${event}` };

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM_EMAIL, to: [to], reply_to: REPLY_TO, subject: mail.subject, html: mail.html })
  });
  const data = await r.json().catch(() => ({}));
  return r.ok
    ? { status: 'sent', detail: data.id || '' }
    : { status: 'failed', detail: JSON.stringify(data).slice(0, 500) };
}

async function sendWhatsApp(phone, event, o) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId) return { status: 'skipped', detail: 'WhatsApp not configured yet' };

  const digits = String(phone || '').replace(/\D/g, '').slice(-10);
  if (digits.length !== 10) return { status: 'skipped', detail: 'no valid 10-digit phone on file' };

  const params = waParams(event, o);
  if (!params) return { status: 'skipped', detail: `no WhatsApp template for ${event}` };

  const r = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: '91' + digits,
      type: 'template',
      template: {
        name: WA_TEMPLATES[event],
        language: { code: 'en' },
        components: [{ type: 'body', parameters: params.map(t => ({ type: 'text', text: String(t) })) }]
      }
    })
  });
  const data = await r.json().catch(() => ({}));
  return r.ok
    ? { status: 'sent', detail: data?.messages?.[0]?.id || '' }
    : { status: 'failed', detail: JSON.stringify(data).slice(0, 500) };
}

// event: 'confirmed' | 'shipped' | 'delivered'
async function notifyOrder(supabaseAdmin, orderId, event) {
  const { data: order } = await supabaseAdmin
    .from('orders')
    .select('id, user_id, order_number, total, customer_name, shipping_full_name, shipping_phone, awb_code, courier_name, tracking_url')
    .eq('id', orderId)
    .maybeSingle();
  if (!order) return;

  // Don't send the same event twice for the same order (e.g. PayU webhook retries).
  const { data: already } = await supabaseAdmin
    .from('notification_log')
    .select('id')
    .eq('order_id', orderId)
    .eq('event', event)
    .eq('status', 'sent')
    .limit(1);
  if (already && already.length) return;

  let profile = null;
  let wantsUpdates = true;
  if (order.user_id) {
    const { data: p } = await supabaseAdmin
      .from('profiles').select('full_name, email, phone').eq('id', order.user_id).maybeSingle();
    profile = p;
    const { data: ns } = await supabaseAdmin
      .from('notification_settings').select('order_updates').eq('user_id', order.user_id).maybeSingle();
    if (ns && ns.order_updates === false) wantsUpdates = false;
  }

  const info = {
    name: (order.shipping_full_name || order.customer_name || profile?.full_name || 'there').split(' ')[0],
    order_number: order.order_number,
    total: order.total,
    courier_name: order.courier_name,
    awb_code: order.awb_code,
    tracking_url: order.tracking_url
  };
  const email = profile?.email || null;
  const phone = order.shipping_phone || profile?.phone || null;

  const log = (channel, recipient, result) => supabaseAdmin.from('notification_log').insert({
    order_id: orderId, event, channel, recipient, status: result.status, detail: result.detail || null
  });

  if (!wantsUpdates) {
    await log('email', email, { status: 'skipped', detail: 'customer turned off order updates' });
    await log('whatsapp', phone, { status: 'skipped', detail: 'customer turned off order updates' });
    return;
  }

  const [emailRes, waRes] = await Promise.all([
    sendEmail(email, event, info).catch(err => ({ status: 'failed', detail: err.message })),
    sendWhatsApp(phone, event, info).catch(err => ({ status: 'failed', detail: err.message }))
  ]);
  await log('email', email, emailRes);
  await log('whatsapp', phone, waRes);
}

module.exports = { notifyOrder };
