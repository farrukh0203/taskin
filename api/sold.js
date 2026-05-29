const crypto = require('crypto');
const qs     = require('querystring');

function sha256(value) {
  if (!value) return undefined;
  return crypto.createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
}

async function sendMetaEvent(payload) {
  const pixelId = process.env.META_PIXEL_ID;
  const token   = process.env.META_ACCESS_TOKEN;
  const url = `https://graph.facebook.com/v19.0/${pixelId}/events?access_token=${token}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
    console.log('[META QUALIFIEDLEAD] QualifiedLead yuborildi:', JSON.stringify(data));
  return data;
}

module.exports = async function handler(req, res) {
  // AmoCRM qayta urinmasligi uchun har doim 200
  if (req.method !== 'POST') return res.status(200).end();

  try {
    const subdomain = process.env.AMO_SUBDOMAIN;
    const amoToken  = process.env.AMO_TOKEN;
    const soldStageId = Number(process.env.AMO_SOLD_STATUS_ID);

    // Webhook — application/x-www-form-urlencoded
    let body = req.body;
    if (typeof body === 'string') body = qs.parse(body);

    // Barcha status o'zgarishlarini tekshirish
    const statuses = body?.['leads[status]'] || {};
    let matchedLeadId = null;

    // Vercel/Next webhook parses arrays as leads[status][0][id] etc.
    // Flat parse orqali qidirish
    const rawKeys = Object.keys(body);
    for (const key of rawKeys) {
      const statusMatch = key.match(/leads\[status\]\[(\d+)\]\[status_id\]/);
      if (statusMatch && Number(body[key]) === soldStageId) {
        const i = statusMatch[1];
        matchedLeadId = body[`leads[status][${i}][id]`];
        break;
      }
    }

    if (!matchedLeadId) {
      console.log('[sold.js] Sotildi etap emas, o\'tkazib yuborildi');
      return res.status(200).end();
    }

    const leadId = matchedLeadId;
    console.log('[sold.js] Sotildi lid ID:', leadId);

    // Lid ma'lumotlarini olish
    const leadRes = await fetch(
      `https://${subdomain}.amocrm.ru/api/v4/leads/${leadId}?with=contacts`,
      { headers: { Authorization: `Bearer ${amoToken}` } }
    );
    const leadData = await leadRes.json();
    const price      = leadData?.price || 0;
    const contactId  = leadData?._embedded?.contacts?.[0]?.id;

    if (!contactId) {
      console.log('[sold.js] Kontakt topilmadi');
      return res.status(200).end();
    }

    // Kontaktdan telefon, FBP, FBC olish
    const contactRes = await fetch(
      `https://${subdomain}.amocrm.ru/api/v4/contacts/${contactId}`,
      { headers: { Authorization: `Bearer ${amoToken}` } }
    );
    const contactData = await contactRes.json();

    let phone = '';
    let fbp   = '';
    let fbc   = '';
    let firstName = (contactData?.name || '').split(' ')[0];

    const fields = contactData?.custom_fields_values || [];
    for (const f of fields) {
      if (f.field_id === Number(process.env.AMO_FIELD_FBP)) fbp = f.values?.[0]?.value || '';
      if (f.field_id === Number(process.env.AMO_FIELD_FBC)) fbc = f.values?.[0]?.value || '';
    }

    // Telefon — standart maydondan
    const phonesField = contactData?.custom_fields_values?.find(f => f.field_code === 'PHONE');
    if (phonesField) phone = phonesField.values?.[0]?.value || '';

    console.log('[sold.js] Meta ga yuboriladigan ma\'lumotlar:', JSON.stringify({
      event_id: `sold_${leadId}`,
      phone_hashed: sha256(phone) || 'BOŠ',
      fn_hashed: sha256(firstName) || 'BOŠ',
      fbp: fbp || 'BOŠ',
      fbc: fbc || 'BOŠ',
      value: Math.round(price / 12000),
      currency: 'USD',
    }));

    // Meta CAPI Purchase event
    await sendMetaEvent({
      data: [{
        event_name: 'QualifiedLead',
        event_time: Math.floor(Date.now() / 1000),
        event_id:   `sold_${leadId}`,
        action_source: 'system_generated',
        user_data: {
          ph:  sha256(phone),
          fn:  sha256(firstName),
          fbp: fbp || undefined,
          fbc: fbc || undefined,
        },
      }],
    });

    return res.status(200).end();
  } catch (err) {
    console.error('[sold.js] Xatolik:', err);
    return res.status(200).end(); // AmoCRM qayta urmasin
  }
};
