const crypto = require('crypto');

function sha256(value) {
  return crypto.createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
}

function cleanPhone(raw) {
  const digits = raw.replace(/\D/g, '');
  if (digits.startsWith('998') && digits.length === 12) return '+' + digits;
  if (digits.startsWith('8') && digits.length === 11) return '+7' + digits.slice(1);
  if (digits.length === 9) return '+998' + digits;
  return '+' + digits;
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
  console.log('[META CAPI] Lead event yuborildi:', JSON.stringify(data));
  return data;
}

async function findContactByPhone(phone, subdomain, token) {
  const url = `https://${subdomain}.amocrm.ru/api/v4/contacts?query=${encodeURIComponent(phone)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  const data = await res.json();
  return data?._embedded?.contacts?.[0] || null;
}

async function createContact(name, phone, fbp, fbc, subdomain, token) {
  const fields = [];
  if (process.env.AMO_FIELD_FBP && fbp) {
    fields.push({ field_id: Number(process.env.AMO_FIELD_FBP), values: [{ value: fbp }] });
  }
  if (process.env.AMO_FIELD_FBC && fbc) {
    fields.push({ field_id: Number(process.env.AMO_FIELD_FBC), values: [{ value: fbc }] });
  }

  const body = [{
    name,
    custom_fields_values: fields,
  }];

  const res = await fetch(`https://${subdomain}.amocrm.ru/api/v4/contacts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  console.log('[AMO] Kontakt yaratildi:', JSON.stringify(data));
  return data?._embedded?.contacts?.[0]?.id;
}

async function updateContactFields(contactId, fbp, fbc, subdomain, token) {
  const fields = [];
  if (process.env.AMO_FIELD_FBP && fbp) {
    fields.push({ field_id: Number(process.env.AMO_FIELD_FBP), values: [{ value: fbp }] });
  }
  if (process.env.AMO_FIELD_FBC && fbc) {
    fields.push({ field_id: Number(process.env.AMO_FIELD_FBC), values: [{ value: fbc }] });
  }
  if (!fields.length) return;

  await fetch(`https://${subdomain}.amocrm.ru/api/v4/contacts`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([{ id: contactId, custom_fields_values: fields }]),
  });
}

async function createLead(name, contactId, subdomain, token) {
  const body = [{
    name: `Ariza — ${name}`,
    pipeline_id: Number(process.env.AMO_PIPELINE_ID),
    status_id:   Number(process.env.AMO_STAGE_ID),
    _embedded: {
      contacts: [{ id: contactId }],
      tags: [{ name: 'CAPI' }],
    },
  }];

  const res = await fetch(`https://${subdomain}.amocrm.ru/api/v4/leads`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  console.log('[AMO] Lid yaratildi:', JSON.stringify(data));
  return data?._embedded?.leads?.[0]?.id;
}

async function addNote(leadId, text, subdomain, token) {
  const body = [{
    entity_id: leadId,
    note_type: 'common',
    params: { text },
  }];
  await fetch(`https://${subdomain}.amocrm.ru/api/v4/leads/notes`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ ok: false });

  try {
    const { name, phone, eventId, fbp, fbc, userAgent, sourceUrl } = req.body;

    const cleanedPhone = cleanPhone(phone || '');
    const firstName    = (name || '').split(' ')[0];
    const subdomain    = process.env.AMO_SUBDOMAIN;
    const amoToken     = process.env.AMO_TOKEN;

    // 1 — Meta CAPI Lead event
    await sendMetaEvent({
      data: [{
        event_name: 'Lead',
        event_time: Math.floor(Date.now() / 1000),
        event_id:   eventId,
        event_source_url: sourceUrl || process.env.SITE_URL,
        action_source: 'website',
        user_data: {
          ph:                sha256(cleanedPhone),
          fn:                sha256(firstName),
          fbp:               fbp || undefined,
          fbc:               fbc || undefined,
          client_user_agent: userAgent || '',
        },
      }],
    });

    // 2 — AmoCRM: kontakt qidirish yoki yaratish
    let contact = await findContactByPhone(cleanedPhone, subdomain, amoToken);
    let contactId;

    if (contact) {
      contactId = contact.id;
      await updateContactFields(contactId, fbp, fbc, subdomain, amoToken);
      console.log('[AMO] Mavjud kontakt yangilandi, ID:', contactId);
    } else {
      contactId = await createContact(name, cleanedPhone, fbp, fbc, subdomain, amoToken);
    }

    // 3 — Lid yaratish
    const leadId = await createLead(name, contactId, subdomain, amoToken);

    // 4 — Izoh qo'shish
    const noteText = [
      `Ism: ${name}`,
      `Telefon: ${cleanedPhone}`,
      `Manba: ${sourceUrl || process.env.SITE_URL}`,
      fbp ? `FBP: ${fbp}` : '',
      fbc ? `FBC: ${fbc}` : '',
    ].filter(Boolean).join('\n');

    await addNote(leadId, noteText, subdomain, amoToken);

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[lead.js] Xatolik:', err);
    return res.status(200).json({ ok: false, error: err.message });
  }
};
