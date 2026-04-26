// netlify/functions/stripe-webhook.js
// POST /.netlify/functions/stripe-webhook
//
// On checkout.session.completed:
//   1. Extracts all booking metadata from the Stripe session
//   2. Appends a row to Google Sheets (the booking ledger / source of truth)
//   3. Creates a Google Calendar event for the appointment
//
// Register this URL in Stripe Dashboard → Developers → Webhooks:
//   https://your-site.netlify.app/.netlify/functions/stripe-webhook
// Events to enable:
//   checkout.session.completed
//   customer.subscription.created   (optional, for recurring confirmation)
//   invoice.payment_failed          (optional, for recurring failure alerts)
//
// Required env vars:
//   STRIPE_SECRET_KEY
//   STRIPE_WEBHOOK_SECRET          (from Stripe Webhook signing secret)
//   GOOGLE_SERVICE_ACCOUNT_EMAIL
//   GOOGLE_PRIVATE_KEY
//   GOOGLE_SHEET_ID
//   GOOGLE_CALENDAR_ID             (e.g. gaygef@gmail.com — must share calendar with service account)

const stripe     = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { google } = require('googleapis');

const SHEET_TAB = 'Bookings';

// ─────────────────────────────────────────────
// AUTH — single JWT used for both Sheets & Calendar
// ─────────────────────────────────────────────
function getGoogleAuth() {
  return new google.auth.JWT({
    email:  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key:    (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/calendar',
    ],
  });
}

// ─────────────────────────────────────────────
// GOOGLE SHEETS — append one booking row
// ─────────────────────────────────────────────
// Sheet columns (A–K):
// A Timestamp | B Customer Name | C Email | D Phone | E Address
// F Cleaning Type | G Frequency | H Date | I Time Slot
// J Stripe Session/Sub ID | K Status
async function appendBookingRow(auth, meta, sessionId) {
  const sheets = google.sheets({ version: 'v4', auth });
  const now    = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });

  const row = [
    now,
    meta.customer_name   || '',
    meta.customer_email  || '',
    meta.phone           || '',
    meta.address         || '',
    meta.cleaning_type   || '',
    meta.frequency       || '',
    meta.preferred_date  || '',
    meta.time_slot       || '',
    sessionId            || '',
    'Booked',
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId:     process.env.GOOGLE_SHEET_ID,
    range:             `${SHEET_TAB}!A:K`,
    valueInputOption:  'USER_ENTERED',
    insertDataOption:  'INSERT_ROWS',
    resource: { values: [row] },
  });

  console.log(`✅ Appended booking row for ${meta.customer_name} on ${meta.preferred_date} @ ${meta.time_slot}`);
}

// ─────────────────────────────────────────────
// GOOGLE CALENDAR — create appointment event
// ─────────────────────────────────────────────
// Slot start times → hour (24h)
const SLOT_HOURS = {
  '9:00 AM':  9,
  '12:00 PM': 12,
  '3:00 PM':  15,
};

// Default duration by cleaning type (hours)
const CLEAN_DURATION = {
  'Standard Cleaning':        2,
  'Deep Cleaning':            3,
  'Move-In / Move-Out Cleaning': 3.5,
};

async function createCalendarEvent(auth, meta) {
  const calendar  = google.calendar({ version: 'v3', auth });
  const calendarId = process.env.GOOGLE_CALENDAR_ID || 'gaygef@gmail.com';

  const date      = meta.preferred_date; // YYYY-MM-DD
  const slotLabel = meta.time_slot;
  const startHour = SLOT_HOURS[slotLabel];

  if (!date || startHour === undefined) {
    console.warn('Cannot create calendar event — missing date or unrecognized slot:', date, slotLabel);
    return;
  }

  const durationHrs = CLEAN_DURATION[meta.cleaning_type] || 2.5;
  const durationMins = Math.round(durationHrs * 60);

  // Build ISO datetimes in Eastern time (Netlify functions run UTC)
  // We encode the local time directly and mark as America/New_York
  const padded     = (n) => String(n).padStart(2, '0');
  const startLocal = `${date}T${padded(startHour)}:00:00`;
  const endHour    = Math.floor(startHour + durationHrs);
  const endMin     = Math.round((durationHrs % 1) * 60);
  const endLocal   = `${date}T${padded(endHour)}:${padded(endMin)}:00`;

  const title = `${meta.cleaning_type || 'Cleaning'} – ${meta.customer_name || 'Customer'}`;

  const description = [
    `📞 Phone: ${meta.phone || 'N/A'}`,
    `📧 Email: ${meta.customer_email || 'N/A'}`,
    `🏠 Home: ${meta.home_summary || meta.address || 'N/A'}`,
    `🧹 Service: ${meta.cleaning_type || 'N/A'}`,
    `📅 Frequency: ${meta.frequency || 'N/A'}`,
    meta.notes ? `💬 Notes: ${meta.notes}` : null,
    ``,
    `💳 Stripe Session: ${meta.session_id || 'N/A'}`,
    `📌 Booked via PristinePairCleaning.com`,
  ].filter(s => s !== null).join('\n');

  const event = {
    summary:     title,
    location:    meta.address || '',
    description,
    start: {
      dateTime: startLocal,
      timeZone: 'America/New_York',
    },
    end: {
      dateTime: endLocal,
      timeZone: 'America/New_York',
    },
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'email',  minutes: 24 * 60 }, // 1 day before
        { method: 'popup',  minutes: 60 },       // 1 hour before
      ],
    },
    colorId: '2', // Sage green — looks great for cleaning appointments
  };

  const created = await calendar.events.insert({
    calendarId,
    resource: event,
  });

  console.log(`📅 Calendar event created: ${created.data.htmlLink}`);
}

// ─────────────────────────────────────────────
// MAIN WEBHOOK HANDLER
// ─────────────────────────────────────────────
exports.handler = async (event) => {
  const sig    = event.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  let stripeEvent;
  try {
    stripeEvent = secret
      ? stripe.webhooks.constructEvent(event.body, sig, secret)
      : JSON.parse(event.body);
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return { statusCode: 400, body: `Webhook error: ${err.message}` };
  }

  // ── Handle checkout.session.completed ──
  if (stripeEvent.type === 'checkout.session.completed') {
    const session    = stripeEvent.data.object;
    const meta       = { ...(session.metadata || {}), session_id: session.id };
    const sessionId  = session.id;
    const isRecurring = meta.is_recurring === 'true';

    console.log('💳 Payment confirmed:', {
      id:       sessionId,
      customer: meta.customer_name,
      email:    meta.customer_email,
      date:     meta.preferred_date,
      time:     meta.time_slot,
      service:  meta.cleaning_type,
      amount:   isRecurring ? 'subscription' : `$${(session.amount_total / 100).toFixed(2)}`,
    });

    const auth = getGoogleAuth();

    // Run Sheets + Calendar in parallel for speed
    const [sheetsResult, calendarResult] = await Promise.allSettled([
      appendBookingRow(auth, meta, sessionId),
      createCalendarEvent(auth, meta),
    ]);

    if (sheetsResult.status === 'rejected') {
      console.error('❌ Google Sheets append failed:', sheetsResult.reason?.message);
    }
    if (calendarResult.status === 'rejected') {
      console.error('❌ Google Calendar event failed:', calendarResult.reason?.message);
    }
  }

  // ── Subscription created (recurring) ──
  else if (stripeEvent.type === 'customer.subscription.created') {
    const sub  = stripeEvent.data.object;
    const meta = sub.metadata || {};
    console.log('🔄 Subscription started:', sub.id, meta.customer_name);
  }

  // ── Payment failed (recurring) ──
  else if (stripeEvent.type === 'invoice.payment_failed') {
    const inv  = stripeEvent.data.object;
    console.warn('❌ Recurring payment failed:', inv.id, inv.customer_email);
    // TODO: send failure notification email to customer
  }

  else {
    console.log('Unhandled webhook event:', stripeEvent.type);
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
