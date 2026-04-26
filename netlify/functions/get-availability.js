// netlify/functions/get-availability.js
// GET /.netlify/functions/get-availability?date=YYYY-MM-DD
// Returns: { bookedSlots: ["9:00 AM", "3:00 PM"] }
//
// Reads the bookings Google Sheet and returns which time slots
// are already taken for the requested date.
//
// Required env vars (set in Netlify → Site Settings → Environment Variables):
//   GOOGLE_SERVICE_ACCOUNT_EMAIL  — e.g. pristine-pair@your-project.iam.gserviceaccount.com
//   GOOGLE_PRIVATE_KEY            — the full private key from the service account JSON
//   GOOGLE_SHEET_ID               — the ID from your Sheet URL:
//                                   docs.google.com/spreadsheets/d/SHEET_ID/edit

const { google } = require('googleapis');

// Column indices in your Google Sheet (0-based)
// Row layout: Timestamp | Name | Email | Phone | Address | Type | Frequency | Date | TimeSlot | StripeID | Status
const COL_DATE      = 7;   // Column H
const COL_TIME_SLOT = 8;   // Column I
const COL_STATUS    = 10;  // Column K — we only count "Booked" rows

const SHEET_TAB = 'Bookings'; // Name of the sheet tab

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const date = (event.queryStringParameters || {}).date;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid or missing date parameter (expected YYYY-MM-DD)' }) };
  }

  try {
    const auth = new google.auth.JWT({
      email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key:   (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });

    const sheets = google.sheets({ version: 'v4', auth });
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: `${SHEET_TAB}!A2:K`, // Skip header row
    });

    const rows = response.data.values || [];
    const bookedSlots = rows
      .filter(row => {
        const rowDate   = (row[COL_DATE]      || '').trim();
        const rowStatus = (row[COL_STATUS]    || '').trim().toLowerCase();
        return rowDate === date && rowStatus === 'booked';
      })
      .map(row => (row[COL_TIME_SLOT] || '').trim())
      .filter(Boolean);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ date, bookedSlots }),
    };
  } catch (err) {
    console.error('get-availability error:', err.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Failed to fetch availability', bookedSlots: [] }),
    };
  }
};
