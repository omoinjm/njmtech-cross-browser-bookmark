/**
 * Delivers the one-time credential email a registration/reset generates.
 * Route code depends on this interface, not on the template API directly —
 * a different email backend later just means a new implementation.
 */
export interface EmailSender {
  sendAccountCredentials(email: string, password: string): Promise<void>;
}

const TEMPLATE_API_URL = 'https://api.template.njmtech.co.za/template';
const LOGIN_URL = 'https://bookmarks.njmtech.co.za';

/**
 * Talks to the njmtech-email-template-api's `bookmark-sync-engine` client
 * (see that repo's api/views/pages/clients/bookmark-sync-engine/
 * account_credentials.ejs) — a deliberately non-Big-Tech, self-hosted
 * alternative to a third-party identity provider. No auth header: that
 * endpoint has no API key, just IP rate limiting on its own side (10
 * req/15min) — registrations/resets are infrequent enough for a
 * personal-scale tool that this is a non-issue.
 */
export class TemplateApiEmailSender implements EmailSender {
  async sendAccountCredentials(email: string, password: string): Promise<void> {
    // The template API requires first_name/last_name even though this
    // project's own signup only ever collects an email — derived from the
    // address purely to satisfy that validation. The template itself only
    // ever displays the first token of the resulting displayName.
    const [localPart] = email.split('@');

    const response = await fetch(TEMPLATE_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client: 'bookmark-sync-engine',
        template_name: 'account_credentials',
        first_name: localPart || 'there',
        last_name: 'User',
        email,
        password,
        loginUrl: LOGIN_URL,
      }),
    });

    if (!response.ok) {
      throw new Error(`Email API responded ${response.status}: ${await response.text().catch(() => '')}`);
    }
  }
}
