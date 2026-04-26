// netlify/functions/create-checkout-session.js
// POST /.netlify/functions/create-checkout-session
//
// • One-time payments  → mode: 'payment'
// • Recurring plans    → mode: 'subscription'  (uses pre-created Stripe Price IDs)
// • Backend double-booking guard before session creation
//
// Required env vars (Netlify → Site Settings → Environment Variables):
//   STRIPE_SECRET_KEY
//   GOOGLE_SERVICE_ACCOUNT_EMAIL
//   GOOGLE_PRIVATE_KEY
//   GOOGLE_SHEET_ID
//   URL  (auto-set by Netlify, or set manually to your domain)

const stripe     = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { google } = require('googleapis');

const SHEET_TAB    = 'Bookings';
const COL_DATE     = 7;   // Column H (0-based)
const COL_TIMESLOT = 8;   // Column I
const COL_STATUS   = 10;  // Column K

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function getSheetsClient() {
  const auth = new google.auth.JWT({
    email:  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key:    (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function isSlotTaken(date, timeSlot) {
  try {
    const sheets = getSheetsClient();
    const res    = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: `${SHEET_TAB}!A2:K`,
    });
    return (res.data.values || []).some(row =>
      (row[COL_DATE]     || '').trim() === date     &&
      (row[COL_TIMESLOT] || '').trim() === timeSlot &&
      (row[COL_STATUS]   || '').trim().toLowerCase() === 'booked'
    );
  } catch (err) {
    console.warn('Slot-check skipped (non-fatal):', err.message);
    return false; // fail open — don't block checkout
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const {
    isRecurring, stripePriceId, amount,
    serviceDesc,
    customerName, customerEmail, phone, address, notes,
    homeSummary, cleaningType, frequency,
    preferredDate, timeSlot,
    location, bedrooms, bathrooms, homeSize,
  } = body;

  // Validate required fields
  if (!preferredDate || !timeSlot)
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Date and time slot are required' }) };
  if (!isRecurring && (!amount || isNaN(amount) || Number(amount) < 1))
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid amount' }) };
  if (isRecurring && !stripePriceId)
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Stripe Price ID required for recurring bookings' }) };

  // Backend double-booking guard
  if (await isSlotTaken(preferredDate, timeSlot))
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ slotTaken: true }) };

  const siteUrl = process.env.URL || 'https://your-site.netlify.app';

  const metadata = {
    customer_name:  customerName  || '',
    customer_email: customerEmail || '',
    phone:          phone         || '',
    address:        address       || '',
    notes:          notes         || '',
    cleaning_type:  cleaningType  || '',
    frequency:      frequency     || '',
    preferred_date: preferredDate || '',
    time_slot:      timeSlot      || '',
    location:       location      || '',
    home_summary:   homeSummary   || '',
    bedrooms:       String(bedrooms  || ''),
    bathrooms:      String(bathrooms || ''),
    home_size:      homeSize      || '',
    service_desc:   serviceDesc   || '',
    is_recurring:   isRecurring ? 'true' : 'false',
  };

  try {
    let session;

    if (isRecurring) {
      session = await stripe.checkout.sessions.create({
        payment_method_types:     ['card'],
        mode:                     'subscription',
        customer_email:           customerEmail || undefined,
        line_items:               [{ price: stripePriceId, quantity: 1 }],
        subscription_data:        { metadata },
        metadata,
        billing_address_collection: 'auto',
        success_url: `${siteUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url:  `${siteUrl}/#booking`,
      });

    } else {
      const cents   = Math.round(Number(amount) * 100);
      const itemDesc = [
        homeSummary   ? `Home: ${homeSummary}`   : null,
        preferredDate ? `Date: ${preferredDate}` : null,
        timeSlot      ? `Time: ${timeSlot}`      : null,
        address       ? `Address: ${address}`    : null,
        phone         ? `Phone: ${phone}`        : null,
        notes         ? `Notes: ${notes}`        : null,
      ].filter(Boolean).join(' | ');

      session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        mode:                 'payment',
        customer_email:       customerEmail || undefined,
        line_items: [{
          price_data: {
            currency:     'usd',
            unit_amount:  cents,
            product_data: {
              name:        `Pristine Pair — ${serviceDesc || 'Cleaning Service'}`,
              description: itemDesc || undefined,
            },
          },
          quantity: 1,
        }],
        payment_intent_data:        { metadata },
        metadata,
        billing_address_collection: 'auto',
        success_url: `${siteUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url:  `${siteUrl}/#booking`,
      });
    }

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ sessionId: session.id }) };

  } catch (err) {
    console.error('Stripe session error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
