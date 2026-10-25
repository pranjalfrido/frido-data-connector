// Sends alert emails via Microsoft Graph API using existing Azure AD app credentials

const GRAPH_URL = 'https://graph.microsoft.com/v1.0';

let _tokenCache = null;

async function getAccessToken() {
  if (_tokenCache && _tokenCache.expiresAt > Date.now() + 30000) {
    return _tokenCache.token;
  }

  const tenantId = process.env.AZURE_TENANT_ID;
  const clientId = process.env.AZURE_CLIENT_ID;
  const clientSecret = process.env.AZURE_CLIENT_SECRET;

  if (!tenantId || !clientId || !clientSecret) {
    throw new Error('Missing Azure credentials for mailer');
  }

  const res = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
        scope: 'https://graph.microsoft.com/.default',
      }),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token fetch failed: ${err}`);
  }

  const data = await res.json();
  _tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return _tokenCache.token;
}

export async function sendAlertEmail(subject, bodyLines) {
  const alertEmail = process.env.ALERT_EMAIL || 'data.team@myfrido.com';
  const senderEmail = process.env.ALERT_SENDER_EMAIL || alertEmail;

  try {
    const token = await getAccessToken();

    const htmlBody = `
      <div style="font-family:Arial,sans-serif;max-width:600px">
        <div style="background:#d93025;color:white;padding:12px 20px;border-radius:4px 4px 0 0">
          <strong>Frido Connector Security Alert</strong>
        </div>
        <div style="border:1px solid #ddd;border-top:none;padding:20px;border-radius:0 0 4px 4px">
          ${bodyLines.map(l => `<p style="margin:6px 0">${l}</p>`).join('')}
          <hr style="border:none;border-top:1px solid #eee;margin:16px 0"/>
          <p style="color:#888;font-size:12px">
            Frido Data Connector · ${new Date().toISOString()} UTC<br/>
            To manage access: <a href="mailto:accounts@myfrido.com">accounts@myfrido.com</a>
          </p>
        </div>
      </div>`;

    const res = await fetch(
      `${GRAPH_URL}/users/${encodeURIComponent(senderEmail)}/sendMail`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: {
            subject: `[Frido Connector Alert] ${subject}`,
            body: { contentType: 'HTML', content: htmlBody },
            toRecipients: [{ emailAddress: { address: alertEmail } }],
          },
          saveToSentItems: false,
        }),
      }
    );

    if (!res.ok) {
      const err = await res.text();
      console.error(`[mailer] sendMail failed: ${err}`);
    }
  } catch (err) {
    console.error(`[mailer] error: ${err.message}`);
  }
}
